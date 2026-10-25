import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SecurityEngine } from '../security/security.js';
import { AuditLogger } from '../audit/audit.js';
import { runProcess, clampTimeout } from '../exec/run.js';

const DEFAULT_MAX_BYTES = 256 * 1024;

function expandPath(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

export interface PackageListResult {
  manager: string;
  packages: Array<{ name: string; version: string; type: 'prod' | 'dev' | 'peer' | 'optional' }>;
  [key: string]: unknown;
}

export interface PackageOutdatedResult {
  packages: Array<{ name: string; current: string; wanted: string; latest: string; type: string }>;
  count: number;
  [key: string]: unknown;
}

export interface PackageAuditResult {
  vulnerabilities: { info: number; low: number; moderate: number; high: number; critical: number; total: number };
  advisories: Array<{ id: string; package: string; severity: string; title: string; url: string; patchedVersions?: string }>;
  [key: string]: unknown;
}

async function detectPackageManager(cwd: string): Promise<'npm' | 'pnpm' | 'yarn' | 'bun' | 'pip' | 'uv' | 'cargo' | 'go' | null> {
  const lockfiles = [
    { file: 'pnpm-lock.yaml', manager: 'pnpm' },
    { file: 'yarn.lock', manager: 'yarn' },
    { file: 'package-lock.json', manager: 'npm' },
    { file: 'bun.lockb', manager: 'bun' },
    { file: 'Cargo.lock', manager: 'cargo' },
    { file: 'go.sum', manager: 'go' },
    { file: 'poetry.lock', manager: 'pip' },
    { file: 'Pipfile.lock', manager: 'pip' },
    { file: 'requirements.txt', manager: 'pip' },
  ];
  for (const { file, manager } of lockfiles) {
    if (fs.existsSync(path.join(cwd, file))) return manager as any;
  }
  if (fs.existsSync(path.join(cwd, 'package.json'))) return 'npm';
  if (fs.existsSync(path.join(cwd, 'pyproject.toml'))) return 'pip';
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) return 'cargo';
  if (fs.existsSync(path.join(cwd, 'go.mod'))) return 'go';
  return null;
}

export async function runPackageList(
  config: { manager?: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'pip' | 'uv' | 'cargo' | 'go'; cwd?: string; depth?: number },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<PackageListResult> {
  const cwd = config.cwd ? expandPath(config.cwd) : process.cwd();
  const manager = config.manager ?? await detectPackageManager(cwd);

  if (!manager) {
    throw new Error('Could not detect package manager');
  }

  const decision = await security.authorize('package.list', { manager, cwd });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  let packages: Array<{ name: string; version: string; type: 'prod' | 'dev' | 'peer' | 'optional' }> = [];

  if (manager === 'npm' || manager === 'pnpm' || manager === 'yarn' || manager === 'bun') {
    const cmd = manager === 'yarn' ? 'yarn' : manager;
    const args = ['list', '--json', '--depth', String(config.depth ?? 0)];
    if (manager === 'pnpm') args.push('--prod');
    const result = await runProcess({ file: cmd, args, cwd, timeoutMs: 30000, maxOutputBytes: DEFAULT_MAX_BYTES });
    try {
      const data = JSON.parse(result.stdout);
      if (data.dependencies) {
        for (const [name, info] of Object.entries(data.dependencies)) {
          const dep = info as any;
          packages.push({ name, version: dep.version || 'unknown', type: dep.dev ? 'dev' : 'prod' });
        }
      }
    } catch {}
  } else if (manager === 'pip') {
    const result = await runProcess({ file: 'pip', args: ['list', '--format=json'], cwd, timeoutMs: 30000, maxOutputBytes: DEFAULT_MAX_BYTES });
    try {
      packages = JSON.parse(result.stdout).map((p: any) => ({ name: p.name, version: p.version, type: 'prod' }));
    } catch {}
  } else if (manager === 'uv') {
    const result = await runProcess({ file: 'uv', args: ['pip', 'list', '--format=json'], cwd, timeoutMs: 30000, maxOutputBytes: DEFAULT_MAX_BYTES });
    try {
      packages = JSON.parse(result.stdout).map((p: any) => ({ name: p.name, version: p.version, type: 'prod' }));
    } catch {}
  } else if (manager === 'cargo') {
    const result = await runProcess({ file: 'cargo', args: ['metadata', '--format-version=1', '--no-deps'], cwd, timeoutMs: 30000, maxOutputBytes: DEFAULT_MAX_BYTES });
    try {
      const data = JSON.parse(result.stdout);
      packages = data.packages.map((p: any) => ({ name: p.name, version: p.version, type: 'prod' }));
    } catch {}
  } else if (manager === 'go') {
    const result = await runProcess({ file: 'go', args: ['list', '-m', '-json', 'all'], cwd, timeoutMs: 30000, maxOutputBytes: DEFAULT_MAX_BYTES });
    try {
      for (const line of result.stdout.trim().split('\n')) {
        const pkg = JSON.parse(line);
        if (pkg.Path && !pkg.Main) {
          packages.push({ name: pkg.Path, version: pkg.Version, type: 'prod' });
        }
      }
    } catch {}
  }

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'package.list',
    decision: 'allow',
    result: `manager=${manager} packages=${packages.length} argsHash=${argsHash}`
  });

  return { manager, packages };
}

export async function runPackageOutdated(
  config: { manager?: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'pip' | 'uv' | 'cargo' | 'go'; cwd?: string },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<PackageOutdatedResult> {
  const cwd = config.cwd ? expandPath(config.cwd) : process.cwd();
  const manager = config.manager ?? await detectPackageManager(cwd);

  if (!manager) {
    throw new Error('Could not detect package manager');
  }

  const decision = await security.authorize('package.outdated', { manager, cwd });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  let packages: Array<{ name: string; current: string; wanted: string; latest: string; type: string }> = [];

  if (manager === 'npm' || manager === 'pnpm' || manager === 'yarn' || manager === 'bun') {
    const cmd = manager === 'yarn' ? 'yarn' : manager;
    const args = manager === 'npm' ? ['outdated', '--json'] : manager === 'pnpm' ? ['outdated', '--json'] : ['outdated', '--json'];
    const result = await runProcess({ file: cmd, args, cwd, timeoutMs: 60000, maxOutputBytes: DEFAULT_MAX_BYTES });
    try {
      const data = JSON.parse(result.stdout);
      if (Array.isArray(data)) {
        packages = data.map((p: any) => ({ name: p.name, current: p.current, wanted: p.wanted, latest: p.latest, type: p.type || 'prod' }));
      } else if (data.body) {
        packages = data.body.map((p: any) => ({ name: p.name, current: p.current, wanted: p.wanted, latest: p.latest, type: p.type || 'prod' }));
      }
    } catch {}
  } else if (manager === 'pip') {
    const result = await runProcess({ file: 'pip', args: ['list', '--outdated', '--format=json'], cwd, timeoutMs: 60000, maxOutputBytes: DEFAULT_MAX_BYTES });
    try {
      packages = JSON.parse(result.stdout).map((p: any) => ({ name: p.name, current: p.version, wanted: p.latest_version, latest: p.latest_version, type: 'prod' }));
    } catch {}
  } else if (manager === 'uv') {
    const result = await runProcess({ file: 'uv', args: ['pip', 'list', '--outdated', '--format=json'], cwd, timeoutMs: 60000, maxOutputBytes: DEFAULT_MAX_BYTES });
    try {
      packages = JSON.parse(result.stdout).map((p: any) => ({ name: p.name, current: p.version, wanted: p.latest_version, latest: p.latest_version, type: 'prod' }));
    } catch {}
  } else if (manager === 'cargo') {
    const result = await runProcess({ file: 'cargo', args: ['outdated', '--format=json'], cwd, timeoutMs: 60000, maxOutputBytes: DEFAULT_MAX_BYTES });
    try {
      const data = JSON.parse(result.stdout);
      packages = data.map((p: any) => ({ name: p.name, current: p.version, wanted: p.compat, latest: p.latest, type: 'prod' }));
    } catch {}
  } else if (manager === 'go') {
    const result = await runProcess({ file: 'go', args: ['list', '-u', '-m', '-json', 'all'], cwd, timeoutMs: 60000, maxOutputBytes: DEFAULT_MAX_BYTES });
    try {
      for (const line of result.stdout.trim().split('\n')) {
        const pkg = JSON.parse(line);
        if (pkg.Update && pkg.Update.Version) {
          packages.push({ name: pkg.Path, current: pkg.Version, wanted: pkg.Update.Version, latest: pkg.Update.Version, type: 'prod' });
        }
      }
    } catch {}
  }

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'package.outdated',
    decision: 'allow',
    result: `manager=${manager} outdated=${packages.length} argsHash=${argsHash}`
  });

  return { packages, count: packages.length };
}

export async function runPackageAudit(
  config: { manager?: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'pip' | 'uv' | 'cargo' | 'go'; cwd?: string; level?: 'low' | 'moderate' | 'high' | 'critical' },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<PackageAuditResult> {
  const cwd = config.cwd ? expandPath(config.cwd) : process.cwd();
  const manager = config.manager ?? await detectPackageManager(cwd);

  if (!manager) {
    throw new Error('Could not detect package manager');
  }

  const decision = await security.authorize('package.audit', { manager, cwd, level: config.level });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  let vulnerabilities = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  let advisories: Array<{ id: string; package: string; severity: string; title: string; url: string; patchedVersions?: string }> = [];

  if (manager === 'npm' || manager === 'pnpm' || manager === 'yarn' || manager === 'bun') {
    const cmd = manager === 'yarn' ? 'yarn' : manager;
    const args = ['audit', '--json'];
    const result = await runProcess({ file: cmd, args, cwd, timeoutMs: 60000, maxOutputBytes: DEFAULT_MAX_BYTES });
    try {
      const data = JSON.parse(result.stdout);
      if (data.metadata && data.metadata.vulnerabilities) {
        vulnerabilities = data.metadata.vulnerabilities;
      }
      if (data.advisories) {
        advisories = Object.values(data.advisories).map((a: any) => ({
          id: a.id || a.module_name,
          package: a.module_name,
          severity: a.severity,
          title: a.title,
          url: a.url,
          patchedVersions: a.patched_versions
        }));
      }
    } catch {}
  } else if (manager === 'pip') {
    const result = await runProcess({ file: 'pip', args: ['audit', '--format=json'], cwd, timeoutMs: 60000, maxOutputBytes: DEFAULT_MAX_BYTES });
    try {
      const data = JSON.parse(result.stdout);
      for (const v of data.vulnerabilities || []) {
        const sev = v.vulnerability_id || 'moderate';
        vulnerabilities[sev as keyof typeof vulnerabilities] = (vulnerabilities[sev as keyof typeof vulnerabilities] || 0) + 1;
        vulnerabilities.total++;
        advisories.push({
          id: v.id,
          package: v.package,
          severity: sev,
          title: v.summary || '',
          url: v.url || '',
          patchedVersions: v.fixed_versions?.join(', ')
        });
      }
    } catch {}
  } else if (manager === 'cargo') {
    const result = await runProcess({ file: 'cargo', args: ['audit', '--json'], cwd, timeoutMs: 60000, maxOutputBytes: DEFAULT_MAX_BYTES });
    try {
      for (const line of result.stdout.trim().split('\n')) {
        const v = JSON.parse(line);
        if (v.type === 'warning' && v.warning) {
          const w = v.warning;
          const sev = w.severity || 'moderate';
          vulnerabilities[sev as keyof typeof vulnerabilities] = (vulnerabilities[sev as keyof typeof vulnerabilities] || 0) + 1;
          vulnerabilities.total++;
          advisories.push({
            id: w.id,
            package: w.package.name,
            severity: sev,
            title: w.title,
            url: w.url || '',
            patchedVersions: w.patched?.join(', ')
          });
        }
      }
    } catch {}
  } else if (manager === 'go') {
    const result = await runProcess({ file: 'go', args: ['vulncheck', '-json', './...'], cwd, timeoutMs: 60000, maxOutputBytes: DEFAULT_MAX_BYTES });
    try {
      for (const line of result.stdout.trim().split('\n')) {
        const v = JSON.parse(line);
        if (v.Finding) {
          const sev = v.Finding.Severity || 'moderate';
          vulnerabilities[sev.toLowerCase() as keyof typeof vulnerabilities] = (vulnerabilities[sev.toLowerCase() as keyof typeof vulnerabilities] || 0) + 1;
          vulnerabilities.total++;
          advisories.push({
            id: v.Finding.OSV,
            package: v.Finding.Module,
            severity: sev,
            title: v.Finding.Summary,
            url: `https://pkg.go.dev/vuln/${v.Finding.OSV}`
          });
        }
      }
    } catch {}
  }

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'package.audit',
    decision: 'allow',
    result: `manager=${manager} vulns=${vulnerabilities.total} argsHash=${argsHash} (registry query performed)`
  });

  return { vulnerabilities, advisories };
}