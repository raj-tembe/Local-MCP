import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SecurityEngine } from '../security/security.js';
import { AuditLogger } from '../audit/audit.js';
import { runProcess, clampTimeout } from '../exec/run.js';

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 20000;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

interface LspServer {
  proc: import('node:child_process').ChildProcess;
  language: string;
  root: string;
  lastUsed: number;
  requestId: number;
  pending: Map<number, (v: any) => void>;
  initialized: boolean;
  initializedPromise: Promise<void>;
}

const lspServers = new Map<string, LspServer>();

function expandPath(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

function getLspCommand(language: string): string[] | null {
  const commands: Record<string, string[]> = {
    typescript: ['typescript-language-server', '--stdio'],
    javascript: ['typescript-language-server', '--stdio'],
    python: ['pylsp'],
    rust: ['rust-analyzer'],
    go: ['gopls'],
    java: ['jdtls'],
    cpp: ['clangd'],
    c: ['clangd'],
    ruby: ['solargraph', 'stdio'],
    php: ['phpactor', 'language-server'],
  };
  return commands[language.toLowerCase()] || null;
}

async function checkLspAvailable(language: string): Promise<boolean> {
  const cmd = getLspCommand(language);
  if (!cmd) return false;
  try {
    const result = await runProcess({ file: cmd[0], args: ['--version'], timeoutMs: 5000 });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

function getServerKey(language: string, root: string): string {
  return `${language}:${createHash('sha256').update(root).digest('hex').slice(0, 12)}`;
}

async function startLspServer(language: string, root: string): Promise<LspServer> {
  const key = getServerKey(language, root);
  const existing = lspServers.get(key);
  if (existing && existing.initialized) {
    existing.lastUsed = Date.now();
    return existing;
  }

  const cmd = getLspCommand(language);
  if (!cmd) {
    throw new Error(`No LSP server configured for ${language}`);
  }

  const available = await checkLspAvailable(language);
  if (!available) {
    throw new Error(`UNAVAILABLE: LSP server for ${language} not found (expected: ${cmd[0]})`);
  }

  let initialized = false;
  let initResolve: () => void = () => {};
  const initializedPromise = new Promise<void>(resolve => { initResolve = resolve; });

  const proc = require('node:child_process').spawn(cmd[0], cmd.slice(1), {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let requestId = 0;
  const pending = new Map<number, (v: any) => void>();

  let buffer = '';

  const handleMessage = (msg: any) => {
    if (msg.id !== undefined && pending.has(msg.id)) {
      const resolve = pending.get(msg.id)!;
      pending.delete(msg.id);
      resolve(msg);
    }
    if (msg.method === 'window/logMessage') {
      // ignore
    }
  };

  proc.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith('Content-Length:')) continue;
      try {
        const msg = JSON.parse(line);
        handleMessage(msg);
      } catch {}
    }
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    // ignore stderr
  });

  proc.on('exit', () => {
    lspServers.delete(key);
  });

  const server: LspServer = {
    proc,
    language,
    root,
    lastUsed: Date.now(),
    requestId: 0,
    pending,
    initialized: false,
    initializedPromise
  };

  lspServers.set(key, server);

  // Initialize
  const initId = ++server.requestId;
  const initParams = {
    jsonrpc: '2.0',
    id: initId,
    method: 'initialize',
    params: {
      processId: process.pid,
      rootUri: `file://${root}`,
      capabilities: {},
      workspaceFolders: [{ uri: `file://${root}`, name: path.basename(root) }]
    }
  };

  proc.stdin?.write(`Content-Length: ${Buffer.byteLength(JSON.stringify(initParams))}\r\n\r\n${JSON.stringify(initParams)}`);

  const initResponse = await Promise.race([
    new Promise((resolve) => { pending.set(initId, resolve); }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('LSP initialize timeout')), 10000))
  ]);

  if ((initResponse as any).error) {
    proc.kill();
    lspServers.delete(key);
    throw new Error(`LSP initialize failed: ${(initResponse as any).error.message}`);
  }

  // Send initialized notification
  const initializedNotif = {
    jsonrpc: '2.0',
    method: 'initialized',
    params: {}
  };
  proc.stdin?.write(`Content-Length: ${Buffer.byteLength(JSON.stringify(initializedNotif))}\r\n\r\n${JSON.stringify(initializedNotif)}`);

  // Open the target file to get diagnostics
  server.initialized = true;
  initResolve();

  // Cleanup idle servers
  setInterval(() => {
    const now = Date.now();
    for (const [k, s] of lspServers.entries()) {
      if (now - s.lastUsed > IDLE_TIMEOUT_MS) {
        try { s.proc.kill('SIGTERM'); } catch {}
        lspServers.delete(k);
      }
    }
  }, 60000).unref();

  process.on('exit', () => {
    for (const s of lspServers.values()) {
      try { s.proc.kill('SIGTERM'); } catch {}
    }
  });

  return server;
}

export interface LspDiagnosticsResult {
  server: string;
  diagnostics: Array<{
    file: string;
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
    severity: number;
    code?: string | number;
    source: string;
    message: string;
  }>;
  truncated: boolean;
  [key: string]: unknown;
}

export async function runLspDiagnostics(
  config: { path: string; server?: string; timeoutMs?: number; maxBytes?: number },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<LspDiagnosticsResult> {
  const filePath = expandPath(config.path);
  const root = path.dirname(filePath);
  const language = config.server || detectLanguageFromPath(filePath);

  const decision = await security.authorize('lsp.diagnostics', { path: filePath, language });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  const server = await startLspServer(language, root);
  server.lastUsed = Date.now();

  const timeoutMs = clampTimeout(config.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;

  // Open the file
  const content = await fsp.readFile(filePath, 'utf8');
  const openId = ++server.requestId;
  const openParams = {
    jsonrpc: '2.0',
    id: openId,
    method: 'textDocument/didOpen',
    params: {
      textDocument: {
        uri: `file://${filePath}`,
        languageId: language,
        version: 1,
        text: content
      }
    }
  };
  server.proc.stdin?.write(`Content-Length: ${Buffer.byteLength(JSON.stringify(openParams))}\r\n\r\n${JSON.stringify(openParams)}`);

  // Wait for diagnostics
  const diagnosticsPromise = new Promise<any[]>((resolve, reject) => {
    const handle = (msg: any) => {
      if (msg.method === 'textDocument/publishDiagnostics' && msg.params.uri === `file://${filePath}`) {
        server.pending.delete(openId);
        resolve(msg.params.diagnostics);
      }
    };
    const oldHandle = server.proc.stdout?.listeners('data');
    server.proc.stdout?.on('data', (chunk: Buffer) => {
      const lines = (server as any)._buffer + chunk.toString('utf8').split('\n');
      (server as any)._buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line || line.startsWith('Content-Length:')) continue;
        try { handle(JSON.parse(line)); } catch {}
      }
    });
    setTimeout(() => { reject(new Error('Diagnostics timeout')); }, timeoutMs);
  });

  const diagnostics = await diagnosticsPromise;

  const result: LspDiagnosticsResult['diagnostics'] = diagnostics.map((d: any) => ({
    file: filePath,
    line: d.range.start.line + 1,
    column: d.range.start.character + 1,
    endLine: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
    severity: d.severity || 1,
    code: d.code,
    source: d.source || language,
    message: d.message
  }));

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'lsp.diagnostics',
    decision: 'allow',
    result: `path=${filePath} language=${language} diagnostics=${result.length} argsHash=${argsHash}`
  });

  return { server: language, diagnostics: result, truncated: false };
}

function detectLanguageFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const langMap: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.py': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.java': 'java',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.c': 'c',
    '.h': 'cpp',
    '.hpp': 'cpp',
    '.rb': 'ruby',
    '.php': 'php',
  };
  return langMap[ext] || 'typescript';
}