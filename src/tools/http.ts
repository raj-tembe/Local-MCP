import { createHash } from 'node:crypto';
import { SecurityEngine } from '../security/security.js';
import { AuditLogger } from '../audit/audit.js';
import { loadConfig } from '../config/config.js';

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;
const DEFAULT_MAX_BYTES = 256 * 1024;
const MAX_REDIRECTS = 5;

const METADATA_IP_RANGES = [
  '169.254.0.0/16',      // AWS/Azure/GCP metadata
  'fd00:ec2::254',       // AWS IPv6 metadata
];

const METADATA_HOSTNAMES = [
  'metadata.google.internal',
  'metadata.azure.com',
  '169.254.169.254',
];

function isPrivateIP(ip: string): boolean {
  if (ip.startsWith('127.')) return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('172.')) {
    const parts = ip.split('.');
    const second = parseInt(parts[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('169.254.')) return true;
  if (ip === '::1' || ip.startsWith('fe80:')) return true;
  if (ip.startsWith('fc00:') || ip.startsWith('fd00:')) return true;
  return false;
}

function checkSSRF(host: string, allowPrivateNetworks: boolean): void {
  for (const hn of METADATA_HOSTNAMES) {
    if (host === hn || host.endsWith('.' + hn)) {
      throw new Error('SSRF guard: metadata hostname blocked');
    }
  }
  for (const range of METADATA_IP_RANGES) {
    if (ipInRange(host, range)) {
      throw new Error('SSRF guard: metadata IP range blocked');
    }
  }
  if (!allowPrivateNetworks && isPrivateIP(host)) {
    throw new Error('SSRF guard: private network access blocked (enable http.allowPrivateNetworks to allow)');
  }
}

function ipInRange(ip: string, range: string): boolean {
  if (!range.includes('/')) return ip === range;
  const [rangeIP, bits] = range.split('/');
  const mask = parseInt(bits, 10);
  if (isNaN(mask)) return false;
  if (ip.includes(':')) return false;
  const ipParts = ip.split('.').map(Number);
  const rangeParts = rangeIP.split('.').map(Number);
  if (ipParts.length !== 4 || rangeParts.length !== 4) return false;
  const ipNum = (ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3];
  const rangeNum = (rangeParts[0] << 24) | (rangeParts[1] << 16) | (rangeParts[2] << 8) | rangeParts[3];
  const maskNum = ~((1 << (32 - mask)) - 1);
  return (ipNum & maskNum) === (rangeNum & maskNum);
}

export interface HttpRequestResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: 'utf8' | 'base64';
  truncated: boolean;
  durationMs: number;
  redirects: string[];
  [key: string]: unknown;
}

export async function runHttpRequest(
  config: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    bodyEncoding?: 'utf8' | 'base64';
    timeoutMs?: number;
    followRedirects?: boolean;
    maxBytes?: number;
  },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<HttpRequestResult> {
  const allowPrivateNetworks = loadConfig().http?.allowPrivateNetworks ?? false;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(config.url);
  } catch {
    throw new Error('Invalid URL');
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('Only http: and https: schemes are allowed');
  }

  checkSSRF(parsedUrl.hostname, allowPrivateNetworks);

  const decision = await security.authorize('http.request', { 
    url: config.url, 
    method: config.method ?? 'GET',
    host: parsedUrl.hostname 
  });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  const method = (config.method ?? 'GET').toUpperCase();
  const headers = { ...config.headers };
  const bodyEncoding = config.bodyEncoding ?? 'utf8';
  const timeoutMs = Math.min(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
  const followRedirects = config.followRedirects ?? false;

  let body: string | undefined;
  if (config.body !== undefined) {
    if (bodyEncoding === 'base64') {
      body = Buffer.from(config.body, 'base64').toString('utf8');
    } else {
      body = config.body;
    }
  }

  const redirects: string[] = [];
  let currentUrl = config.url;
  let currentMethod = method;
  let currentBody = body;
  let currentHeaders = { ...headers };

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    let response: Response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      
      response = await fetch(currentUrl, {
        method: currentMethod,
        headers: currentHeaders,
        body: currentBody,
        redirect: 'manual',
        signal: controller.signal
      });
      clearTimeout(timeoutId);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        throw new Error('Request timeout');
      }
      throw new Error(`Request failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (response.status >= 300 && response.status < 400 && followRedirects && redirectCount < MAX_REDIRECTS) {
      const location = response.headers.get('location');
      if (!location) break;
      
      const redirectUrl = new URL(location, currentUrl);
      redirects.push(redirectUrl.toString());
      
      checkSSRF(redirectUrl.hostname, allowPrivateNetworks);
      
      if (currentMethod !== 'GET' && currentMethod !== 'HEAD') {
        currentMethod = 'GET';
        currentBody = undefined;
      }
      
      const authHeader = currentHeaders['authorization'];
      const cookieHeader = currentHeaders['cookie'];
      if ((authHeader || cookieHeader) && new URL(currentUrl).origin !== redirectUrl.origin) {
        delete currentHeaders['authorization'];
        delete currentHeaders['cookie'];
      }
      
      currentUrl = redirectUrl.toString();
      continue;
    }

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });

    let responseBody = '';
    let truncated = false;
    let bytesRead = 0;
    
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesRead += value.length;
        if (bytesRead > maxBytes) {
          const remaining = maxBytes - (bytesRead - value.length);
          if (remaining > 0) {
            responseBody += new TextDecoder('utf8', { fatal: false }).decode(value.slice(0, remaining));
          }
          truncated = true;
          break;
        }
        responseBody += new TextDecoder('utf8', { fatal: false }).decode(value);
      }
    }

    const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
    audit.log({
      timestamp: new Date().toISOString(),
      sessionId,
      tool: 'http.request',
      decision: 'allow',
      result: `url=${new URL(config.url).origin} method=${method} status=${response.status} bytes=${bytesRead} truncated=${truncated} redirects=${redirects.length} argsHash=${argsHash}`
    });

    return {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: responseBody,
      bodyEncoding: 'utf8',
      truncated,
      durationMs: 0,
      redirects
    };
  }

  throw new Error('Max redirects exceeded');
}