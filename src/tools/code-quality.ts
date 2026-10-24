import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SecurityEngine } from '../security/security.js';
import { AuditLogger } from '../audit/audit.js';
import { runProcess, clampTimeout } from '../exec/run.js';

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 60000;

function expandPath(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

async function findExecutable(name: string): Promise<string | null> {
  const pathDirs = process.env.PATH?.split(path.delimiter) || [];
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of pathDirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        await fsp.access(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

async function detectFormatter(cwd: string): Promise<string | null> {
  const formatters = [
    { name: 'prettier', config: ['.prettierrc', '.prettierrc.json', '.prettierrc.js', 'prettier.config.js'], bin: 'prettier' },
    { name: 'black', config: ['pyproject.toml'], bin: 'black' },
    { name: 'ruff', config: ['pyproject.toml', 'ruff.toml'], bin: 'ruff' },
    { name: 'gofmt', config: ['go.mod'], bin: 'gofmt' },
    { name: 'rustfmt', config: ['Cargo.toml'], bin: 'rustfmt' },
  ];

  for (const fmt of formatters) {
    const hasConfig = fmt.config.some(f => fs.existsSync(path.join(cwd, f)));
    const hasBin = await findExecutable(fmt.bin);
    if (hasConfig && hasBin) return fmt.name;
  }
  return null;
}

async function detectLinter(cwd: string): Promise<string | null> {
  const linters = [
    { name: 'eslint', config: ['eslint.config.js', '.eslintrc.js', '.eslintrc.json'], bin: 'eslint' },
    { name: 'ruff', config: ['pyproject.toml', 'ruff.toml'], bin: 'ruff' },
    { name: 'golangci-lint', config: ['.golangci.yml', '.golangci.yaml', 'golangci.yml'], bin: 'golangci-lint' },
    { name: 'clippy', config: ['Cargo.toml'], bin: 'clippy-driver' },
  ];

  for (const lint of linters) {
    const hasConfig = lint.config.some(f => fs.existsSync(path.join(cwd, f)));
    const hasBin = await findExecutable(lint.bin);
    if (hasConfig && hasBin) return lint.name;
  }
  return null;
}

export interface CodeFormatResult {
  formatter: string;
  formatted: string[];
  unchanged: string[];
  errors: Array<{ path: string; message: string }>;
  [key: string]: unknown;
}

export interface CodeLintResult {
  linter: string;
  diagnostics: Array<{
    file: string;
    line: number;
    column: number;
    endLine?: number;
    endColumn?: number;
    severity: 'error' | 'warning' | 'info';
    rule?: string;
    message: string;
    fixable?: boolean;
  }>;
  counts: { error: number; warning: number; info: number };
  fixed?: string[];
  [key: string]: unknown;
}

export async function runCodeFormat(
  config: {
    paths?: string[];
    cwd?: string;
    formatter?: 'prettier' | 'black' | 'ruff' | 'gofmt' | 'rustfmt' | 'auto';
    check?: boolean;
    dryRun?: boolean;
    maxBytes?: number;
  },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<CodeFormatResult> {
  const cwd = config.cwd ? expandPath(config.cwd) : process.cwd();
  const isDryRun = config.dryRun ?? false;
  const check = config.check ?? false;
  const formatterName = config.formatter ?? 'auto';

  if (!isDryRun && !check) {
    const decision = await security.authorize('code.format', { paths: config.paths, cwd, formatter: formatterName });
    if (!decision.allowed) {
      throw new Error(decision.reason ?? 'Permission denied');
    }
  } else {
    const toolCheck = security.checkToolAllowed('code.format');
    if (!toolCheck.allowed) {
      throw new Error(toolCheck.reason ?? 'Permission denied');
    }
  }

  let formatter = formatterName;
  if (formatter === 'auto') {
    formatter = (await detectFormatter(cwd) || 'prettier') as 'prettier' | 'black' | 'ruff' | 'gofmt' | 'rustfmt' | 'auto';
  }

  const formatterCommands: Record<string, { bin: string; args: (files: string[], check: boolean) => string[] }> = {
    prettier: { bin: 'prettier', args: (files, check) => [check ? '--check' : '--write', ...files] },
    black: { bin: 'black', args: (files, check) => [check ? '--check' : '', ...files].filter(Boolean) },
    ruff: { bin: 'ruff', args: (files, check) => ['format', check ? '--check' : '', ...files].filter(Boolean) },
    gofmt: { bin: 'gofmt', args: (files, check) => [check ? '-d' : '-w', ...files] },
    rustfmt: { bin: 'rustfmt', args: (files, check) => [check ? '--check' : '', ...files].filter(Boolean) },
  };

  const fmt = formatterCommands[formatter];
  if (!fmt) {
    return {
      formatter,
      formatted: [],
      unchanged: [],
      errors: [{ path: '', message: `Unknown formatter: ${formatter}` }]
    };
  }

  const binPath = await findExecutable(fmt.bin);
  if (!binPath) {
    return {
      formatter,
      formatted: [],
      unchanged: [],
      errors: [{ path: '', message: `${fmt.bin} not found on PATH. Install it to use ${formatter}.` }]
    };
  }

  const targetPaths = config.paths && config.paths.length > 0 
    ? config.paths.map(p => expandPath(p))
    : [cwd];

  const formatted: string[] = [];
  const unchanged: string[] = [];
  const errors: Array<{ path: string; message: string }> = [];

  for (const target of targetPaths) {
    const stat = await fsp.stat(target).catch(() => null);
    if (!stat) {
      errors.push({ path: target, message: 'Path not found' });
      continue;
    }

    let files: string[] = [];
    if (stat.isFile()) {
      files = [target];
    } else {
      const walk = async (dir: string): Promise<string[]> => {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        const result: string[] = [];
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!['node_modules', '.git', 'dist', 'build', 'target'].includes(entry.name)) {
              result.push(...await walk(full));
            }
          } else if (entry.isFile()) {
            result.push(full);
          }
        }
        return result;
      };
      files = await walk(target);
    }

    for (const file of files) {
      try {
        const args = fmt.args([file], check);
        const result = await runProcess({
          file: binPath,
          args,
          cwd,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          maxOutputBytes: config.maxBytes ?? DEFAULT_MAX_BYTES
        });
        
        if (result.exitCode === 0) {
          if (check && result.stdout) {
            unchanged.push(file);
          } else if (!check) {
            formatted.push(file);
          } else {
            unchanged.push(file);
          }
        } else if (result.exitCode === 1 && check) {
          formatted.push(file);
        } else {
          errors.push({ path: file, message: result.stderr || 'Format failed' });
        }
      } catch (e) {
        errors.push({ path: file, message: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'code.format',
    decision: isDryRun ? 'allow' : 'allow',
    result: `dryRun=${isDryRun} check=${check} formatter=${formatter} formatted=${formatted.length} errors=${errors.length} argsHash=${argsHash}`
  });

  return { formatter, formatted, unchanged, errors };
}

export async function runCodeLint(
  config: {
    paths?: string[];
    cwd?: string;
    linter?: 'eslint' | 'ruff' | 'golangci-lint' | 'clippy' | 'auto';
    fix?: boolean;
    dryRun?: boolean;
    maxBytes?: number;
  },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<CodeLintResult> {
  const cwd = config.cwd ? expandPath(config.cwd) : process.cwd();
  const isDryRun = config.dryRun ?? false;
  const fix = config.fix ?? false;
  const linterName = config.linter ?? 'auto';

  if (!isDryRun && fix) {
    const decision = await security.authorize('code.lint', { paths: config.paths, cwd, linter: linterName, fix: true });
    if (!decision.allowed) {
      throw new Error(decision.reason ?? 'Permission denied');
    }
  } else {
    const toolCheck = security.checkToolAllowed('code.lint');
    if (!toolCheck.allowed) {
      throw new Error(toolCheck.reason ?? 'Permission denied');
    }
  }

  let linter = linterName;
  if (linter === 'auto') {
    linter = (await detectLinter(cwd) || 'eslint') as 'eslint' | 'ruff' | 'golangci-lint' | 'clippy' | 'auto';
  }

  const linterCommands: Record<string, { bin: string; args: (files: string[], fix: boolean) => string[]; parse: (output: string) => CodeLintResult['diagnostics'] }> = {
    eslint: {
      bin: 'eslint',
      args: (files, fix) => ['--format', 'json', fix ? '--fix' : '', ...files].filter(Boolean),
      parse: (output) => {
        try {
          const results = JSON.parse(output);
          const diagnostics: CodeLintResult['diagnostics'] = [];
          for (const result of results) {
            for (const msg of result.messages) {
              diagnostics.push({
                file: result.filePath,
                line: msg.line || 1,
                column: msg.column || 1,
                endLine: msg.endLine,
                endColumn: msg.endColumn,
                severity: msg.severity === 2 ? 'error' : msg.severity === 1 ? 'warning' : 'info',
                rule: msg.ruleId,
                message: msg.message,
                fixable: msg.fix !== undefined
              });
            }
          }
          return diagnostics;
        } catch {
          return [];
        }
      }
    },
    ruff: {
      bin: 'ruff',
      args: (files, fix) => ['check', '--output-format', 'json', fix ? '--fix' : '', ...files].filter(Boolean),
      parse: (output) => {
        try {
          const results = JSON.parse(output);
          return results.map((msg: any) => ({
            file: msg.filename,
            line: msg.location.row,
            column: msg.location.column,
            endLine: msg.end_location?.row,
            endColumn: msg.end_location?.column,
            severity: ['error', 'warning', 'info'][Math.min(msg.code?.length || 0, 2)] as any,
            rule: msg.code,
            message: msg.message,
            fixable: msg.fix !== undefined
          }));
        } catch {
          return [];
        }
      }
    },
    'golangci-lint': {
      bin: 'golangci-lint',
      args: (files, fix) => ['run', '--out-format', 'json', fix ? '--fix' : '', ...files].filter(Boolean),
      parse: (output) => {
        try {
          const results = JSON.parse(output);
          const diagnostics: CodeLintResult['diagnostics'] = [];
          for (const issue of results.Issues || []) {
            diagnostics.push({
              file: issue.Pos.Filename,
              line: issue.Pos.Line,
              column: issue.Pos.Column,
              severity: issue.Severity === 'error' ? 'error' : 'warning',
              rule: issue.FromLinter,
              message: issue.Text,
              fixable: false
            });
          }
          return diagnostics;
        } catch {
          return [];
        }
      }
    },
    clippy: {
      bin: 'cargo',
      args: (files, fix) => ['clippy', '--message-format=json', fix ? '--fix' : '', '--', ...files].filter(Boolean),
      parse: (output) => {
        const diagnostics: CodeLintResult['diagnostics'] = [];
        for (const line of output.split('\n').filter(Boolean)) {
          try {
            const msg = JSON.parse(line);
            if (msg.reason === 'compiler-message' && msg.message.spans) {
              for (const span of msg.message.spans) {
                diagnostics.push({
                  file: span.file_name,
                  line: span.line_start,
                  column: span.column_start,
                  endLine: span.line_end,
                  endColumn: span.column_end,
                  severity: msg.message.level === 'error' ? 'error' : 'warning',
                  rule: msg.message.code?.code,
                  message: msg.message.rendered || msg.message.message,
                  fixable: false
                });
              }
            }
          } catch {}
        }
        return diagnostics;
      }
    }
  };

  const lint = linterCommands[linter];
  if (!lint) {
    return {
      linter,
      diagnostics: [],
      counts: { error: 0, warning: 0, info: 0 },
      errors: [{ path: '', message: `Unknown linter: ${linter}` }]
    };
  }

  const binPath = await findExecutable(lint.bin);
  if (!binPath) {
    return {
      linter,
      diagnostics: [],
      counts: { error: 0, warning: 0, info: 0 },
      errors: [{ path: '', message: `${lint.bin} not found on PATH. Install it to use ${linter}.` }]
    };
  }

  const targetPaths = config.paths && config.paths.length > 0 
    ? config.paths.map(p => expandPath(p))
    : [cwd];

  const allDiagnostics: CodeLintResult['diagnostics'] = [];
  let fixed: string[] = [];

  for (const target of targetPaths) {
    try {
      const args = lint.args([target], fix);
      const result = await runProcess({
        file: binPath,
        args,
        cwd,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxOutputBytes: config.maxBytes ?? DEFAULT_MAX_BYTES
      });
      
      const diagnostics = lint.parse(result.stdout);
      allDiagnostics.push(...diagnostics);
      
      if (fix && result.exitCode === 0) {
        fixed.push(target);
      }
    } catch (e) {
      allDiagnostics.push({
        file: target,
        line: 1,
        column: 1,
        severity: 'error',
        message: e instanceof Error ? e.message : String(e)
      });
    }
  }

  const counts = { error: 0, warning: 0, info: 0 };
  for (const d of allDiagnostics) {
    counts[d.severity]++;
  }

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'code.lint',
    decision: isDryRun ? 'allow' : 'allow',
    result: `dryRun=${isDryRun} fix=${fix} linter=${linter} diagnostics=${allDiagnostics.length} errors=${counts.error} argsHash=${argsHash}`
  });

  return { linter, diagnostics: allDiagnostics, counts, fixed };
}