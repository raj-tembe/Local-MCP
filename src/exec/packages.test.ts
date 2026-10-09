import { describe, it, expect } from 'vitest';
import { buildInstallPlan, validatePackageSpec } from './packages.js';

describe('validatePackageSpec', () => {
  it('accepts normal specs', () => {
    for (const spec of ['express', 'zod@3.22.0', '@types/node', 'requests>=2.31', 'numpy==1.26.4', 'git+https://github.com/a/b.git']) {
      expect(validatePackageSpec(spec)).toBeUndefined();
    }
  });

  it('rejects flags, shell metacharacters and whitespace', () => {
    for (const spec of ['--registry=http://evil', '-g', 'a; rm -rf ~', 'a && b', 'a b', '$(whoami)', '`id`', 'a|b', "a'b", '']) {
      expect(validatePackageSpec(spec)).toBeTruthy();
    }
  });
});

describe('buildInstallPlan', () => {
  it('builds npm installs', () => {
    const plan = buildInstallPlan({ manager: 'npm', packages: ['express'], dev: true, ignoreScripts: true });
    expect(plan).toMatchObject({ ok: true, steps: [{ file: 'npm', args: ['install', 'express', '--save-dev', '--ignore-scripts'] }] });
  });

  it('installs from the manifest when no packages are given', () => {
    expect(buildInstallPlan({ manager: 'pnpm' })).toMatchObject({ ok: true, steps: [{ file: 'pnpm', args: ['install'] }] });
    expect(buildInstallPlan({ manager: 'go' })).toMatchObject({ ok: true, steps: [{ file: 'go', args: ['mod', 'download'] }] });
  });

  it('creates a venv first for pip when missing', () => {
    const plan = buildInstallPlan({ manager: 'pip', packages: ['requests'], venv: '/tmp/v' }, { venvExists: false, python: 'python3' });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.steps).toHaveLength(2);
      expect(plan.steps[0]).toEqual({ file: 'python3', args: ['-m', 'venv', '/tmp/v'] });
      expect(plan.steps[1].args).toEqual(['install', 'requests']);
    }
  });

  it('skips venv creation when it exists', () => {
    const plan = buildInstallPlan({ manager: 'pip', packages: ['requests'], venv: '/tmp/v' }, { venvExists: true });
    expect(plan.ok && plan.steps).toHaveLength(1);
  });

  it('uses python -m pip without a venv and supports requirements files', () => {
    expect(buildInstallPlan({ manager: 'pip', packages: ['x'] })).toMatchObject({ ok: true, steps: [{ file: 'python3', args: ['-m', 'pip', 'install', 'x'] }] });
    expect(buildInstallPlan({ manager: 'pip', requirementsFile: 'requirements.txt' })).toMatchObject({ ok: true, steps: [{ args: ['-m', 'pip', 'install', '-r', 'requirements.txt'] }] });
  });

  it('rejects invalid combinations and injected specs', () => {
    expect(buildInstallPlan({ manager: 'npm', packages: ['--registry=evil'] }).ok).toBe(false);
    expect(buildInstallPlan({ manager: 'npm', requirementsFile: 'r.txt' }).ok).toBe(false);
    expect(buildInstallPlan({ manager: 'pip' }).ok).toBe(false);
    expect(buildInstallPlan({ manager: 'yarn', global: true }).ok).toBe(false);
    expect(buildInstallPlan({ manager: 'pip', packages: ['x'], venv: '--system-site-packages' }).ok).toBe(false);
    expect(buildInstallPlan({ manager: 'uv', packages: ['x'], global: true }).ok).toBe(false);
  });
});
