import net from 'node:net';
import { SecurityEngine } from '../security/security.js';
import { AuditLogger } from '../audit/audit.js';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 2000;

export interface PortAddress {
  address: string;
  family: string;
  [key: string]: unknown;
}

export interface PortCheckResult {
  port: number;
  listening: boolean;
  addresses: PortAddress[];
  pid?: number;
  processName?: string;
  [key: string]: unknown;
}

async function getProcessInfo(port: number, host: string): Promise<{ pid?: number; processName?: string }> {
  try {
    if (process.platform === 'linux' || process.platform === 'darwin') {
      const { stdout } = await execFileAsync('lsof', ['-i', `${host}:${port}`, '-t'], { timeout: 3000 }).catch(() => ({ stdout: '' }));
      const pids = stdout.trim().split('\n').filter(Boolean);
      if (pids.length > 0) {
        const pid = parseInt(pids[0], 10);
        if (!isNaN(pid)) {
          try {
            const { stdout: psOut } = await execFileAsync('ps', ['-p', String(pid), '-o', 'comm='], { timeout: 2000 });
            return { pid, processName: psOut.trim() };
          } catch {
            return { pid };
          }
        }
      }
    } else if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'TCP'], { timeout: 3000 }).catch(() => ({ stdout: '' }));
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (line.includes(`:${port} `) && line.includes('LISTENING')) {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[parts.length - 1], 10);
          if (!isNaN(pid)) {
            try {
              const { stdout: taskOut } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeout: 2000 });
              const taskLines = taskOut.trim().split('\n');
              if (taskLines.length > 0) {
                const cols = taskLines[0].split(',').map(c => c.replace(/"/g, ''));
                return { pid, processName: cols[0] };
              }
            } catch {
              return { pid };
            }
          }
        }
      }
    }
  } catch {
    // ignore errors
  }
  return {};
}

export async function runPortCheck(
  config: { port: number; host?: string },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<PortCheckResult> {
  if (config.port < 1 || config.port > 65535) {
    throw new Error('Invalid port: must be between 1 and 65535');
  }

  const host = config.host ?? '127.0.0.1';

  const decision = await security.authorize('port.check', { port: config.port, host });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  let listening = false;
  const addresses: PortAddress[] = [];

  await new Promise<void>((resolve) => {
    const socket = new net.Socket();
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve();
    }, DEFAULT_TIMEOUT_MS);

    socket.on('connect', () => {
      listening = true;
      clearTimeout(timeout);
      const addr = socket.address();
      if (addr && typeof addr === 'object' && 'address' in addr && 'family' in addr) {
        addresses.push({ address: addr.address, family: addr.family });
      }
      socket.end();
      resolve();
    });

    socket.on('error', () => {
      clearTimeout(timeout);
      resolve();
    });

    socket.connect(config.port, host);
  });

  let pid: number | undefined;
  let processName: string | undefined;

  if (listening) {
    const info = await getProcessInfo(config.port, host);
    pid = info.pid;
    processName = info.processName;
  }

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'port.check',
    decision: 'allow',
    result: `port=${config.port} host=${host} listening=${listening} pid=${pid ?? 'unknown'} argsHash=${argsHash}`
  });

  return { port: config.port, listening, addresses, pid, processName };
}