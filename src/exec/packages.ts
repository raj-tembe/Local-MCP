import path from 'node:path';

export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun', 'pip', 'uv', 'cargo', 'go'] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export type InstallRequest = {
  manager: PackageManager;
  packages?: string[];
  dev?: boolean;
  global?: boolean;
  ignoreScripts?: boolean;
  /** pip only: install into this virtualenv (created if missing). */
  venv?: string;
  /** pip only: install from a requirements file instead of listing packages. */
  requirementsFile?: string;
};

export type InstallStep = { file: string; args: string[] };

export type InstallPlan =
  | { ok: true; steps: InstallStep[]; display: string }
  | { ok: false; error: string };

// Conservative allowlist: names, versions, scopes, URLs. No whitespace, quotes, `;`, `|`, `&`, `$`, backticks.
const PACKAGE_SPEC = /^[A-Za-z0-9@][A-Za-z0-9@._/:+~^<>=!*,#-]*$/;
const MAX_SPEC_LENGTH = 214;

export function validatePackageSpec(spec: string): string | undefined {
  if (!spec || spec.length > MAX_SPEC_LENGTH) return `Invalid package spec length: '${spec.slice(0, 40)}'`;
  if (spec.startsWith('-')) return `Package spec may not start with '-': '${spec}'`;
  if (!PACKAGE_SPEC.test(spec)) return `Package spec contains unsupported characters: '${spec}'`;
  return undefined;
}

function venvBin(venv: string, name: string): string {
  return process.platform === 'win32'
    ? path.join(venv, 'Scripts', `${name}.exe`)
    : path.join(venv, 'bin', name);
}

export function buildInstallPlan(req: InstallRequest, opts: { venvExists?: boolean; python?: string } = {}): InstallPlan {
  const packages = req.packages ?? [];
  for (const spec of packages) {
    const problem = validatePackageSpec(spec);
    if (problem) return { ok: false, error: problem };
  }

  if (req.requirementsFile !== undefined && req.manager !== 'pip') {
    return { ok: false, error: "'requirementsFile' is only supported with the pip manager." };
  }
  if (req.venv !== undefined && req.manager !== 'pip') {
    return { ok: false, error: "'venv' is only supported with the pip manager." };
  }
  if (req.venv !== undefined && (!req.venv || req.venv.startsWith('-') || req.venv.includes('\0'))) {
    return { ok: false, error: `Invalid venv path: '${req.venv}'` };
  }
  if (req.global && req.venv) {
    return { ok: false, error: "'global' and 'venv' cannot be combined." };
  }

  const steps: InstallStep[] = [];
  const hasPackages = packages.length > 0;

  switch (req.manager) {
    case 'npm': {
      const args = ['install', ...packages];
      if (hasPackages && req.dev) args.push('--save-dev');
      if (req.global) args.push('-g');
      if (req.ignoreScripts) args.push('--ignore-scripts');
      steps.push({ file: 'npm', args });
      break;
    }
    case 'pnpm': {
      const args = hasPackages ? ['add', ...packages] : ['install'];
      if (hasPackages && req.dev) args.push('--save-dev');
      if (req.global) args.push('-g');
      if (req.ignoreScripts) args.push('--ignore-scripts');
      steps.push({ file: 'pnpm', args });
      break;
    }
    case 'yarn': {
      if (req.global) {
        if (!hasPackages) return { ok: false, error: 'Global yarn install needs at least one package.' };
        steps.push({ file: 'yarn', args: ['global', 'add', ...packages] });
      } else {
        const args = hasPackages ? ['add', ...packages] : ['install'];
        if (hasPackages && req.dev) args.push('--dev');
        if (req.ignoreScripts) args.push('--ignore-scripts');
        steps.push({ file: 'yarn', args });
      }
      break;
    }
    case 'bun': {
      const args = hasPackages ? ['add', ...packages] : ['install'];
      if (hasPackages && req.dev) args.push('--dev');
      if (req.global) args.push('-g');
      if (req.ignoreScripts) args.push('--ignore-scripts');
      steps.push({ file: 'bun', args });
      break;
    }
    case 'pip': {
      if (req.requirementsFile !== undefined) {
        if (!req.requirementsFile || req.requirementsFile.startsWith('-') || req.requirementsFile.includes('\0')) {
          return { ok: false, error: `Invalid requirements file path: '${req.requirementsFile}'` };
        }
        if (hasPackages) return { ok: false, error: "Use either 'packages' or 'requirementsFile', not both." };
      } else if (!hasPackages) {
        return { ok: false, error: "pip needs 'packages' or 'requirementsFile'." };
      }
      if (req.dev) return { ok: false, error: "'dev' is not applicable to pip." };
      if (req.ignoreScripts) return { ok: false, error: "'ignoreScripts' is not applicable to pip." };

      const python = opts.python ?? 'python3';
      let pipFile = python;
      let pipPre = ['-m', 'pip'];
      if (req.venv) {
        if (!opts.venvExists) steps.push({ file: python, args: ['-m', 'venv', req.venv] });
        pipFile = venvBin(req.venv, 'pip');
        pipPre = [];
      }
      const target = req.requirementsFile !== undefined ? ['-r', req.requirementsFile] : packages;
      steps.push({ file: pipFile, args: [...pipPre, 'install', ...target] });
      break;
    }
    case 'uv': {
      if (req.global) return { ok: false, error: "'global' is not supported for uv; use pip with a venv or 'uv tool install' via shell." };
      steps.push({ file: 'uv', args: hasPackages ? ['add', ...(req.dev ? ['--dev'] : []), ...packages] : ['sync'] });
      break;
    }
    case 'cargo': {
      if (req.global) {
        if (!hasPackages) return { ok: false, error: 'cargo install needs at least one crate.' };
        steps.push({ file: 'cargo', args: ['install', ...packages] });
      } else {
        steps.push({ file: 'cargo', args: hasPackages ? ['add', ...(req.dev ? ['--dev'] : []), ...packages] : ['fetch'] });
      }
      break;
    }
    case 'go': {
      if (req.dev) return { ok: false, error: "'dev' is not applicable to go." };
      steps.push({ file: 'go', args: hasPackages ? [req.global ? 'install' : 'get', ...packages] : ['mod', 'download'] });
      break;
    }
  }

  const display = steps.map((s) => [s.file, ...s.args].join(' ')).join(' && ');
  return { ok: true, steps, display };
}
