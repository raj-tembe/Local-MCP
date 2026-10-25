import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SecurityEngine } from '../security/security.js';
import { AuditLogger } from '../audit/audit.js';
import { runProcess } from '../exec/run.js';

const MAX_SESSIONS = 4;
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 300000;
const DEFAULT_MAX_BYTES = 256 * 1024;

interface ReplSession {
  id: string;
  language: 'python' | 'node' | 'ruby';
  proc: import('node:child_process').ChildProcess;
  startedAt: number;
  lastUsedAt: number;
  sentinel: string;
}

const sessions = new Map<string, ReplSession>();

function expandPath(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

function getSentinel(language: string): string {
  return `__REPL_SENTINEL_${language.toUpperCase()}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}__`;
}

function getInterpreter(language: 'python' | 'node' | 'ruby'): string | null {
  switch (language) {
    case 'python':
      return 'python3';
    case 'node':
      return 'node';
    case 'ruby':
      return 'ruby';
  }
}

async function checkInterpreterAvailable(language: 'python' | 'node' | 'ruby'): Promise<string | null> {
  const interpreter = getInterpreter(language);
  if (!interpreter) return null;
  
  try {
    const result = await runProcess({ file: interpreter, args: ['--version'], timeoutMs: 5000 });
    if (result.exitCode === 0) return interpreter;
  } catch {}
  return null;
}

function cleanupSession(id: string): void {
  const session = sessions.get(id);
  if (session) {
    try {
      session.proc.kill('SIGTERM');
      setTimeout(() => {
        try { session.proc.kill('SIGKILL'); } catch {}
      }, 2000);
    } catch {}
    sessions.delete(id);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastUsedAt > IDLE_TIMEOUT_MS) {
      cleanupSession(id);
    }
  }
}, 60000).unref();

process.on('exit', () => {
  for (const id of sessions.keys()) {
    cleanupSession(id);
  }
});

export interface ReplStartResult {
  sessionId: string;
  language: string;
  pid: number;
  banner?: string;
  [key: string]: unknown;
}

export interface ReplEvalResult {
  output: string;
  result?: unknown;
  error?: { type: string; message: string; traceback?: string };
  durationMs: number;
  truncated: boolean;
  [key: string]: unknown;
}

export interface ReplListResult {
  sessions: Array<{
    sessionId: string;
    language: string;
    pid: number;
    idleMs: number;
    startedAt: string;
  }>;
  [key: string]: unknown;
}

export interface ReplCloseResult {
  closed: boolean;
  [key: string]: unknown;
}

export async function runReplStart(
  config: { language: 'python' | 'node' | 'ruby'; cwd?: string; env?: Record<string, string> },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<ReplStartResult> {
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error(`Maximum REPL sessions (${MAX_SESSIONS}) reached`);
  }

  const cwd = config.cwd ? expandPath(config.cwd) : process.cwd();
  const interpreter = await checkInterpreterAvailable(config.language);
  if (!interpreter) {
    throw new Error(`Interpreter for ${config.language} not available`);
  }

  const decision = await security.authorize('repl.start', { language: config.language, cwd, interpreter });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  return new Promise((resolve, reject) => {
    const sentinel = getSentinel(config.language);
    let banner = '';
    let bannerResolved = false;

    const proc = require('node:child_process').spawn(interpreter, ['-i'], {
      cwd,
      env: config.env ? { ...process.env, ...config.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const sessionId = createHash('sha256').update(`${config.language}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 16);
    const session: ReplSession = {
      id: sessionId,
      language: config.language,
      proc,
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
      sentinel
    };
    sessions.set(sessionId, session);

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (!bannerResolved) {
        banner += text;
        if (text.includes(sentinel)) {
          bannerResolved = true;
        }
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (!bannerResolved) {
        banner += text;
        if (text.includes(sentinel)) {
          bannerResolved = true;
        }
      }
    });

    proc.on('error', (err: Error) => {
      sessions.delete(sessionId);
      reject(err);
    });

    proc.on('exit', () => {
      sessions.delete(sessionId);
    });

    setTimeout(() => {
      if (!bannerResolved) {
        bannerResolved = true;
        resolve({ sessionId, language: config.language, pid: proc.pid ?? 0, banner: banner.trim() });
      }
    }, 2000);

    const initCode = config.language === 'python'
      ? `import sys; print('${sentinel}')\n`
      : config.language === 'node'
        ? `console.log('${sentinel}')\n`
        : `puts '${sentinel}'\n`;

    proc.stdin?.write(initCode);
  });
}

export async function runReplEval(
  config: { sessionId: string; code: string; timeoutMs?: number },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<ReplEvalResult> {
  const session = sessions.get(config.sessionId);
  if (!session) {
    throw new Error(`REPL session not found: ${config.sessionId}`);
  }

  session.lastUsedAt = Date.now();

  const decision = await security.authorize('repl.eval', { sessionId: config.sessionId, code: config.code });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  const timeoutMs = Math.min(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxBytes = DEFAULT_MAX_BYTES;

  const sentinel = session.sentinel;
  const codeWithSentinel = `${config.code}\n${session.language === 'python' ? 'print' : session.language === 'node' ? 'console.log' : 'puts'}("${sentinel}")\n`;

  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let settled = false;
    const startTime = Date.now();

    const finish = (result: Partial<ReplEvalResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        output: output.trim(),
        durationMs: Date.now() - startTime,
        truncated: result.truncated ?? false,
        ...result
      });
    };

    const onData = (chunk: Buffer) => {
      if (timedOut || settled) return;
      const text = chunk.toString('utf8');
      if (text.includes(sentinel)) {
        const parts = text.split(sentinel);
        output += parts[0];
        finish({});
        return;
      }
      if (output.length + text.length > maxBytes) {
        output += text.substring(0, maxBytes - output.length);
        timedOut = true;
        session.proc.stdin?.end();
        finish({ output: output + '\n[output truncated]', truncated: true });
        return;
      }
      output += text;
    };

    session.proc.stdout?.on('data', onData);
    session.proc.stderr?.on('data', onData);

    const timer = setTimeout(() => {
      timedOut = true;
      finish({ error: { type: 'TimeoutError', message: 'Execution timed out' }, truncated: true });
    }, timeoutMs);

    session.proc.stdin?.write(codeWithSentinel, (err) => {
      if (err) {
        finish({ error: { type: 'Error', message: err.message } });
      }
    });
  });
}

export async function runReplList(
  config: {},
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<ReplListResult> {
  const decision = await security.authorize('repl.list', {});
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  const now = Date.now();
  const list = Array.from(sessions.values()).map(s => ({
    sessionId: s.id,
    language: s.language,
    pid: s.proc.pid ?? 0,
    idleMs: now - s.lastUsedAt,
    startedAt: new Date(s.startedAt).toISOString()
  }));

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'repl.list',
    decision: 'allow',
    result: `sessions=${list.length} argsHash=${argsHash}`
  });

  return { sessions: list };
}

export async function runReplClose(
  config: { sessionId: string },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<ReplCloseResult> {
  const decision = await security.authorize('repl.close', { sessionId: config.sessionId });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  const session = sessions.get(config.sessionId);
  if (!session) {
    return { closed: false };
  }

  cleanupSession(config.sessionId);

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'repl.close',
    decision: 'allow',
    result: `sessionId=${config.sessionId} argsHash=${argsHash}`
  });

  return { closed: true };
}