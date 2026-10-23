import { SecurityEngine } from '../security/security.js';
import { AuditLogger } from '../audit/audit.js';
import { createHash } from 'node:crypto';

const SECRET_PATTERNS = [
  /key$/i, /token$/i, /secret$/i, /password$/i, /credential$/i,
  /_pat$/i, /auth$/i, /apikey$/i, /access_token$/i, /refresh_token$/i,
  /client_secret$/i, /private_key$/i, /secret_key$/i
];

function isSecretKey(name: string): boolean {
  return SECRET_PATTERNS.some(pattern => pattern.test(name));
}

function matchesFilter(name: string, filter?: string): boolean {
  if (!filter) return true;
  if (filter.includes('*')) {
    const regex = new RegExp('^' + filter.replace(/\*/g, '.*') + '$', 'i');
    return regex.test(name);
  }
  return name.toLowerCase().startsWith(filter.toLowerCase());
}

function maskValue(value: string): string {
  if (value.length <= 3) return '*'.repeat(value.length);
  return value.slice(0, 3) + '*'.repeat(value.length - 3) + ` (len=${value.length})`;
}

export interface EnvVarInfo {
  name: string;
  isSet: boolean;
  length: number;
  valuePreview?: string;
  [key: string]: unknown;
}

export interface EnvListResult {
  vars: EnvVarInfo[];
  total: number;
  redacted: boolean;
  [key: string]: unknown;
}

export async function runEnvList(
  config: { filter?: string; revealValues?: boolean },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<EnvListResult> {
  const decision = await security.authorize('env.list', { filter: config.filter });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  const revealValues = config.revealValues ?? false;
  const filter = config.filter;

  const vars: EnvVarInfo[] = [];
  let redacted = false;

  for (const [name, value] of Object.entries(process.env)) {
    if (!matchesFilter(name, filter)) continue;

    const isSet = value !== undefined;
    const length = value?.length ?? 0;
    let valuePreview: string | undefined;

    if (revealValues && isSet && value) {
      if (isSecretKey(name)) {
        valuePreview = maskValue(value);
        redacted = true;
      } else {
        valuePreview = value.length > 100 ? value.slice(0, 100) + `... (len=${value.length})` : value;
      }
    }

    vars.push({ name, isSet, length, valuePreview });
  }

  vars.sort((a, b) => a.name.localeCompare(b.name));

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'env.list',
    decision: 'allow',
    result: `vars=${vars.length} filtered=${!!filter} revealValues=${revealValues} redacted=${redacted} argsHash=${argsHash}`
  });

  return { vars, total: vars.length, redacted };
}