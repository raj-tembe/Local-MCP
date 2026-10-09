import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess, type RunResult } from './run.js';

export const SUPPORTED_LANGUAGES = ['python', 'javascript', 'typescript', 'bash', 'sh', 'ruby', 'go'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

type LanguageSpec = {
  ext: string;
  /** Candidate launchers in order of preference. `pre` args go before the script path. */
  candidates: Array<{ file: string; pre?: string[] }>;
};

const SPECS: Record<Language, LanguageSpec> = {
  python: { ext: '.py', candidates: [{ file: 'python3' }, { file: 'python' }] },
  javascript: { ext: '.js', candidates: [{ file: 'node' }] },
  typescript: { ext: '.ts', candidates: [{ file: 'tsx' }, { file: 'npx', pre: ['--no-install', 'tsx'] }] },
  bash: { ext: '.sh', candidates: [{ file: 'bash' }] },
  sh: { ext: '.sh', candidates: [{ file: 'sh' }] },
  ruby: { ext: '.rb', candidates: [{ file: 'ruby' }] },
  go: { ext: '.go', candidates: [{ file: 'go', pre: ['run'] }] }
};

export function findExecutable(name: string, envPath: string = process.env.PATH ?? ''): string | undefined {
  const dirs = envPath.split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return undefined;
}

export type ResolvedLanguage = {
  language: Language;
  ext: string;
  /** Executable name used to launch the code (what the command policy sees). */
  file: string;
  pre: string[];
};

export function resolveLanguage(language: Language): ResolvedLanguage | undefined {
  const spec = SPECS[language];
  for (const candidate of spec.candidates) {
    if (findExecutable(candidate.file)) {
      return { language, ext: spec.ext, file: candidate.file, pre: candidate.pre ?? [] };
    }
  }
  return undefined;
}

export type CodeRunOptions = {
  resolved: ResolvedLanguage;
  code: string;
  args?: string[];
  stdin?: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
};

export async function runCode(options: CodeRunOptions): Promise<RunResult & { workDir: string }> {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'local-mcp-run-'));
  const scriptPath = path.join(tempDir, `main${options.resolved.ext}`);
  try {
    await fsp.writeFile(scriptPath, options.code, { encoding: 'utf8', mode: 0o600 });
    const workDir = options.cwd ?? tempDir;
    const result = await runProcess({
      file: options.resolved.file,
      args: [...options.resolved.pre, scriptPath, ...(options.args ?? [])],
      cwd: workDir,
      stdin: options.stdin,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      env: options.env
    });
    return { ...result, workDir };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
