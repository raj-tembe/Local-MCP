import { createHash } from 'node:crypto';
import { SecurityEngine } from '../security/security.js';
import { AuditLogger } from '../audit/audit.js';
import { runProcess, clampTimeout } from '../exec/run.js';

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;

async function checkDockerAvailable(): Promise<boolean> {
  try {
    const result = await runProcess({ file: 'docker', args: ['version'], timeoutMs: 5000 });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export interface DockerPsResult {
  containers: Array<{
    id: string;
    name: string;
    image: string;
    status: string;
    state: string;
    ports: Array<{ host: number; container: number }>;
    created: string;
  }>;
  [key: string]: unknown;
}

export interface DockerLogsResult {
  container: string;
  logs: string;
  truncated: boolean;
  [key: string]: unknown;
}

export interface DockerComposeResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  containers?: string[];
  [key: string]: unknown;
}

export interface DockerExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  [key: string]: unknown;
}

export async function runDockerPs(
  config: { all?: boolean },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<DockerPsResult> {
  if (!(await checkDockerAvailable())) {
    throw new Error('UNAVAILABLE: docker not found on PATH');
  }

  const decision = await security.authorize('docker.ps', { all: config.all });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  const args = ['ps', '--format', 'json'];
  if (config.all) args.push('-a');

  const result = await runProcess({ file: 'docker', args, timeoutMs: DEFAULT_TIMEOUT_MS, maxOutputBytes: DEFAULT_MAX_BYTES });

  const containers = [];
  for (const line of result.stdout.trim().split('\n').filter(Boolean)) {
    try {
      const c = JSON.parse(line);
      const ports = (c.Ports || '').split(', ').map((p: string) => {
        const match = p.match(/0\.0\.0\.0:(\d+)->(\d+)\/tcp/);
        if (match) return { host: parseInt(match[1], 10), container: parseInt(match[2], 10) };
        return null;
      }).filter(Boolean);
      containers.push({
        id: c.ID?.slice(0, 12) || c.Id?.slice(0, 12) || '',
        name: c.Names || c.Name || '',
        image: c.Image || '',
        status: c.Status || '',
        state: c.State || '',
        ports,
        created: c.CreatedAt || ''
      });
    } catch {}
  }

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'docker.ps',
    decision: 'allow',
    result: `containers=${containers.length} argsHash=${argsHash}`
  });

  return { containers };
}

export async function runDockerLogs(
  config: {
    container: string;
    tail?: number;
    since?: string;
    timestamps?: boolean;
    maxBytes?: number;
  },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<DockerLogsResult> {
  if (!(await checkDockerAvailable())) {
    throw new Error('UNAVAILABLE: docker not found on PATH');
  }

  const decision = await security.authorize('docker.logs', { container: config.container, tail: config.tail });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  const args = ['logs'];
  if (config.tail !== undefined) args.push('--tail', String(config.tail));
  if (config.since) args.push('--since', config.since);
  if (config.timestamps) args.push('--timestamps');
  args.push(config.container);

  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
  const result = await runProcess({ file: 'docker', args, timeoutMs: DEFAULT_TIMEOUT_MS, maxOutputBytes: maxBytes });

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'docker.logs',
    decision: 'allow',
    result: `container=${config.container} bytes=${result.stdout.length} truncated=${result.truncated} argsHash=${argsHash}`
  });

  return { container: config.container, logs: result.stdout, truncated: result.truncated };
}

export async function runDockerCompose(
  config: {
    action: 'up' | 'down' | 'ps' | 'logs' | 'build' | 'restart';
    cwd?: string;
    files?: string[];
    services?: string[];
    detach?: boolean;
  },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<DockerComposeResult> {
  if (!(await checkDockerAvailable())) {
    throw new Error('UNAVAILABLE: docker not found on PATH');
  }

  const decision = await security.authorize('docker.compose', { action: config.action, cwd: config.cwd, services: config.services });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  const cwd = config.cwd ?? process.cwd();
  const args = ['compose'];
  if (config.files && config.files.length > 0) {
    for (const f of config.files) args.push('-f', f);
  }
  args.push(config.action);
  if (config.action === 'up') {
    if (config.detach !== false) args.push('-d');
  }
  if (config.services && config.services.length > 0) {
    args.push(...config.services);
  }

  const result = await runProcess({ file: 'docker', args, cwd, timeoutMs: 120000, maxOutputBytes: DEFAULT_MAX_BYTES });

  let containers: string[] | undefined;
  if (config.action === 'ps') {
    const psResult = await runProcess({ file: 'docker', args: ['compose', 'ps', '--format', 'json'], cwd, timeoutMs: DEFAULT_TIMEOUT_MS, maxOutputBytes: DEFAULT_MAX_BYTES });
    containers = psResult.stdout.trim().split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line).Name || JSON.parse(line).Service || ''; } catch { return ''; }
    }).filter(Boolean);
  }

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'docker.compose',
    decision: 'allow',
    result: `action=${config.action} exitCode=${result.exitCode} argsHash=${argsHash}`
  });

  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, containers };
}

export async function runDockerExec(
  config: {
    container: string;
    command: string[];
    user?: string;
    cwd?: string;
    timeoutMs?: number;
  },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<DockerExecResult> {
  if (!(await checkDockerAvailable())) {
    throw new Error('UNAVAILABLE: docker not found on PATH');
  }

  if (!config.command || config.command.length === 0) {
    throw new Error('command array is required');
  }

  const decision = await security.authorize('docker.exec', { container: config.container, command: config.command });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  const args = ['exec'];
  if (config.user) args.push('-u', config.user);
  if (config.cwd) args.push('-w', config.cwd);
  args.push(config.container, ...config.command);

  const timeoutMs = clampTimeout(config.timeoutMs, DEFAULT_TIMEOUT_MS);
  const result = await runProcess({ file: 'docker', args, timeoutMs, maxOutputBytes: DEFAULT_MAX_BYTES });

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'docker.exec',
    decision: 'allow',
    result: `container=${config.container} command=${config.command.join(' ')} exitCode=${result.exitCode} argsHash=${argsHash}`
  });

  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}