import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { glob } from 'glob';
import { SecurityEngine } from '../security/security.js';
import { AuditLogger } from '../audit/audit.js';

const EXTENSION_LANGUAGES: Record<string, string> = {
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.ts': 'TypeScript', '.tsx': 'TypeScript',
  '.py': 'Python', '.pyi': 'Python',
  '.rs': 'Rust',
  '.go': 'Go',
  '.java': 'Java', '.kt': 'Kotlin', '.scala': 'Scala',
  '.cs': 'C#', '.fs': 'F#', '.vb': 'VB.NET',
  '.cpp': 'C++', '.cc': 'C++', '.cxx': 'C++', '.c': 'C', '.h': 'C/C++', '.hpp': 'C++',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.swift': 'Swift',
  '.m': 'Objective-C', '.mm': 'Objective-C++',
  '.sh': 'Shell', '.bash': 'Shell', '.zsh': 'Shell', '.fish': 'Shell',
  '.ps1': 'PowerShell',
  '.lua': 'Lua',
  '.r': 'R',
  '.jl': 'Julia',
  '.dart': 'Dart',
  '.elm': 'Elm',
  '.ex': 'Elixir', '.exs': 'Elixir',
  '.erl': 'Erlang', '.hrl': 'Erlang',
  '.clj': 'Clojure', '.cljs': 'ClojureScript', '.cljc': 'Clojure',
  '.hs': 'Haskell',
  '.ml': 'OCaml', '.mli': 'OCaml',
  '.fsx': 'F#',
  '.vue': 'Vue', '.svelte': 'Svelte',
  '.html': 'HTML', '.htm': 'HTML',
  '.css': 'CSS', '.scss': 'SCSS', '.sass': 'Sass', '.less': 'Less',
  '.json': 'JSON', '.jsonc': 'JSON',
  '.yaml': 'YAML', '.yml': 'YAML',
  '.toml': 'TOML',
  '.xml': 'XML',
  '.md': 'Markdown', '.mdx': 'MDX',
  '.sql': 'SQL',
  '.graphql': 'GraphQL', '.gql': 'GraphQL',
  '.proto': 'Protobuf',
  '.dockerfile': 'Dockerfile', '.containerfile': 'Dockerfile',
  '.tf': 'Terraform', '.tfvars': 'Terraform',
};

const MANIFEST_FILES = {
  'package.json': { language: 'JavaScript/TypeScript', packageManager: 'npm', parser: parsePackageJson },
  'pyproject.toml': { language: 'Python', packageManager: 'pip/uv/poetry', parser: parsePyprojectToml },
  'Cargo.toml': { language: 'Rust', packageManager: 'cargo', parser: parseCargoToml },
  'go.mod': { language: 'Go', packageManager: 'go', parser: parseGoMod },
  'pom.xml': { language: 'Java', packageManager: 'maven', parser: parsePomXml },
  'build.gradle': { language: 'Java/Kotlin', packageManager: 'gradle', parser: parseGradle },
  'build.gradle.kts': { language: 'Kotlin', packageManager: 'gradle', parser: parseGradle },
  'Gemfile': { language: 'Ruby', packageManager: 'bundler', parser: parseGemfile },
  'composer.json': { language: 'PHP', packageManager: 'composer', parser: parseComposerJson },
  '*.csproj': { language: 'C#', packageManager: 'nuget', parser: parseCsproj },
};

const MAX_FILES_CENSUS = 5000;

function expandPath(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

async function parsePackageJson(content: string, filePath: string) {
  try {
    const pkg = JSON.parse(content);
    return {
      scripts: pkg.scripts || {},
      dependencies: { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies },
      name: pkg.name,
      workspaces: pkg.workspaces ? (Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages) : undefined
    };
  } catch { return {}; }
}

async function parsePyprojectToml(content: string, filePath: string) {
  try {
    const scripts: Record<string, string> = {};
    const toolMatch = content.match(/\[tool\.poetry\.scripts\]([\s\S]*?)(?=\n\[|\n*$)/);
    if (toolMatch) {
      for (const line of toolMatch[1].split('\n')) {
        const m = line.match(/^(\w+)\s*=\s*["'](.+)["']/);
        if (m) scripts[m[1]] = m[2];
      }
    }
    return { scripts };
  } catch { return {}; }
}

async function parseCargoToml(content: string, filePath: string) {
  return {};
}

async function parseGoMod(content: string, filePath: string) {
  return {};
}

async function parsePomXml(content: string, filePath: string) {
  return {};
}

async function parseGradle(content: string, filePath: string) {
  return {};
}

async function parseGemfile(content: string, filePath: string) {
  return {};
}

async function parseComposerJson(content: string, filePath: string) {
  try {
    const pkg = JSON.parse(content);
    return { scripts: pkg.scripts || {} };
  } catch { return {}; }
}

async function parseCsproj(content: string, filePath: string) {
  return {};
}

async function detectManifests(root: string, depth: number) {
  const manifests: Array<{ path: string; name: string; data: any }> = [];
  const files = await glob('**/*', { cwd: root, absolute: true, nodir: true, maxDepth: depth });

  for (const file of files) {
    const base = path.basename(file);
    const ext = path.extname(file);
    const key = Object.keys(MANIFEST_FILES).find(k => k === base || k === `*${ext}`);
    if (key) {
      try {
        const content = await fsp.readFile(file, 'utf8');
        const parser = MANIFEST_FILES[key as keyof typeof MANIFEST_FILES].parser;
        const data = await parser(content, file);
        manifests.push({ path: file, name: base, data });
      } catch { }
    }
  }
  return manifests;
}

async function censusLanguages(root: string, depth: number, respectGitignore: boolean) {
  const counts: Record<string, number> = {};
  let total = 0;

  const files = await glob('**/*', { cwd: root, absolute: true, nodir: true, maxDepth: depth, ignore: respectGitignore ? ['**/.git/**', '**/node_modules/**'] : undefined });

  for (const file of files) {
    if (total >= MAX_FILES_CENSUS) break;
    const ext = path.extname(file).toLowerCase();
    const lang = EXTENSION_LANGUAGES[ext];
    if (lang) {
      counts[lang] = (counts[lang] || 0) + 1;
      total++;
    }
  }

  const languages = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, files]) => ({ name, files, percentage: total > 0 ? Math.round((files / total) * 100) : 0 }));

  return { languages, total };
}

function detectFrameworks(manifests: Array<{ path: string; name: string; data: any }>): string[] {
  const frameworks = new Set<string>();
  for (const m of manifests) {
    const deps = m.data.dependencies || {};
    const allDeps = { ...deps, ...m.data.devDependencies };
    if (allDeps.react || allDeps['@types/react']) frameworks.add('React');
    if (allDeps.vue) frameworks.add('Vue');
    if (allDeps.svelte) frameworks.add('Svelte');
    if (allDeps.next) frameworks.add('Next.js');
    if (allDeps.nuxt) frameworks.add('Nuxt');
    if (allDeps.astro) frameworks.add('Astro');
    if (allDeps.express) frameworks.add('Express');
    if (allDeps.fastify) frameworks.add('Fastify');
    if (allDeps.nestjs || allDeps['@nestjs/core']) frameworks.add('NestJS');
    if (allDeps.vite) frameworks.add('Vite');
    if (allDeps.webpack) frameworks.add('Webpack');
    if (allDeps.jest || allDeps.vitest) frameworks.add('Jest/Vitest');
    if (allDeps.cypress) frameworks.add('Cypress');
    if (allDeps.playwright) frameworks.add('Playwright');
    if (allDeps.tailwindcss) frameworks.add('Tailwind CSS');
    if (allDeps.typescript) frameworks.add('TypeScript');
    if (allDeps.eslint) frameworks.add('ESLint');
    if (allDeps.prettier) frameworks.add('Prettier');
    if (m.name === 'pyproject.toml') {
      if (allDeps.django) frameworks.add('Django');
      if (allDeps.flask) frameworks.add('Flask');
      if (allDeps.fastapi) frameworks.add('FastAPI');
      if (allDeps.pytest) frameworks.add('pytest');
    }
    if (m.name === 'Cargo.toml') {
      if (allDeps.actix_web) frameworks.add('Actix Web');
      if (allDeps.axum) frameworks.add('Axum');
      if (allDeps.rocket) frameworks.add('Rocket');
    }
    if (m.name === 'go.mod') {
      if (allDeps.gin) frameworks.add('Gin');
      if (allDeps.echo) frameworks.add('Echo');
    }
  }
  return Array.from(frameworks);
}

function detectPackageManager(manifests: Array<{ path: string; name: string; data: any }>): string | undefined {
  const lockfiles = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'bun.lockb', 'Cargo.lock', 'go.sum', 'poetry.lock', 'Pipfile.lock', 'composer.lock', 'Gemfile.lock'];
  for (const m of manifests) {
    const dir = path.dirname(m.path);
    for (const lf of lockfiles) {
      if (fs.existsSync(path.join(dir, lf))) {
        if (lf === 'pnpm-lock.yaml') return 'pnpm';
        if (lf === 'yarn.lock') return 'yarn';
        if (lf === 'package-lock.json') return 'npm';
        if (lf === 'bun.lockb') return 'bun';
        if (lf === 'Cargo.lock') return 'cargo';
        if (lf === 'go.sum') return 'go';
        if (lf === 'poetry.lock') return 'poetry';
        if (lf === 'Pipfile.lock') return 'pipenv';
        if (lf === 'composer.lock') return 'composer';
        if (lf === 'Gemfile.lock') return 'bundler';
      }
    }
  }
  if (manifests.some(m => m.name === 'package.json')) return 'npm';
  if (manifests.some(m => m.name === 'pyproject.toml')) return 'pip/uv';
  if (manifests.some(m => m.name === 'Cargo.toml')) return 'cargo';
  if (manifests.some(m => m.name === 'go.mod')) return 'go';
  if (manifests.some(m => m.name === 'pom.xml')) return 'maven';
  if (manifests.some(m => m.name === 'build.gradle' || m.name === 'build.gradle.kts')) return 'gradle';
  if (manifests.some(m => m.name === 'Gemfile')) return 'bundler';
  if (manifests.some(m => m.name === 'composer.json')) return 'composer';
  return undefined;
}

function detectMonorepo(manifests: Array<{ path: string; name: string; data: any }>): { isMonorepo: boolean; tool?: string; workspaces: Array<{ name: string; path: string }> } {
  for (const m of manifests) {
    if (m.name === 'package.json' && m.data.workspaces) {
      const ws = Array.isArray(m.data.workspaces) ? m.data.workspaces : m.data.workspaces.packages;
      return {
        isMonorepo: true,
        tool: 'npm/yarn/pnpm workspaces',
        workspaces: ws.map((w: string) => ({ name: path.basename(w), path: w }))
      };
    }
  }
  return { isMonorepo: false, workspaces: [] };
}

function detectEntryPoints(manifests: Array<{ path: string; name: string; data: any }>): string[] {
  const entries: string[] = [];
  for (const m of manifests) {
    if (m.data.scripts) {
      for (const [name] of Object.entries(m.data.scripts)) {
        if (!entries.includes(name)) entries.push(name);
      }
    }
    if (m.data.main) entries.push(m.data.main);
    if (m.data.module) entries.push(m.data.module);
    if (m.data.bin) {
      const bins = typeof m.data.bin === 'string' ? [m.data.bin] : Object.values(m.data.bin);
      entries.push(...bins);
    }
  }
  return entries;
}

function detectTestFramework(manifests: Array<{ path: string; name: string; data: any }>): string | undefined {
  for (const m of manifests) {
    const deps = { ...m.data.dependencies, ...m.data.devDependencies };
    if (deps.jest) return 'jest';
    if (deps.vitest) return 'vitest';
    if (deps.mocha) return 'mocha';
    if (deps.cypress) return 'cypress';
    if (deps.playwright) return 'playwright';
    if (m.name === 'pyproject.toml' && deps.pytest) return 'pytest';
    if (m.name === 'Cargo.toml') return 'cargo test';
    if (m.name === 'go.mod') return 'go test';
  }
  return undefined;
}

function detectCI(root: string): string[] {
  const ciFiles = [
    '.github/workflows', '.gitlab-ci.yml', '.circleci/config.yml',
    'azure-pipelines.yml', 'Jenkinsfile', '.travis.yml', '.drone.yml',
    'bitbucket-pipelines.yml', 'appveyor.yml', '.buildkite'
  ];
  const found: string[] = [];
  for (const cf of ciFiles) {
    const full = path.join(root, cf);
    if (fs.existsSync(full)) {
      found.push(cf.startsWith('.github') ? 'GitHub Actions' : path.basename(cf, path.extname(cf)));
    }
  }
  return found;
}

function detectConfigFiles(root: string): string[] {
  const configs = [
    'tsconfig.json', 'jsconfig.json', 'eslint.config.js', '.eslintrc.js', '.eslintrc.json',
    'prettier.config.js', '.prettierrc', 'jest.config.js', 'vitest.config.ts',
    'webpack.config.js', 'vite.config.ts', 'rollup.config.js',
    'babel.config.js', '.babelrc', 'tailwind.config.js',
    'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt',
    'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts',
    'Gemfile', 'composer.json', '*.csproj', 'Makefile', 'justfile',
    'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml'
  ];
  const found: string[] = [];
  for (const cf of configs) {
    const full = path.join(root, cf);
    if (fs.existsSync(full)) {
      found.push(path.basename(cf));
    }
  }
  return found;
}

export interface ProjectDetectResult {
  languages: Array<{ name: string; files: number; percentage: number }>;
  frameworks: string[];
  packageManager: string | undefined;
  runtimeHints: string[];
  monorepo: { isMonorepo: boolean; tool?: string; workspaces: Array<{ name: string; path: string }> };
  scripts: Record<string, string>;
  entryPoints: string[];
  testFramework: string | undefined;
  ci: string[];
  configFiles: string[];
  [key: string]: unknown;
}

export async function runProjectDetect(
  config: { cwd?: string; depth?: number },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<ProjectDetectResult> {
  const cwd = config.cwd ? expandPath(config.cwd) : process.cwd();
  const depth = config.depth ?? 3;

  const decision = await security.authorize('project.detect', { cwd });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  const manifests = await detectManifests(cwd, depth);
  const { languages, total } = await censusLanguages(cwd, depth, true);
  const frameworks = detectFrameworks(manifests);
  const packageManager = detectPackageManager(manifests);
  const monorepo = detectMonorepo(manifests);
  const scripts: Record<string, string> = {};
  for (const m of manifests) {
    if (m.data.scripts) Object.assign(scripts, m.data.scripts);
  }
  const entryPoints = detectEntryPoints(manifests);
  const testFramework = detectTestFramework(manifests);
  const ci = detectCI(cwd);
  const configFiles = detectConfigFiles(cwd);

  const runtimeHints: string[] = [];
  if (languages.some(l => l.name === 'TypeScript')) runtimeHints.push('TypeScript project - consider tsx for running');
  if (languages.some(l => l.name === 'Python')) runtimeHints.push('Python project - ensure python3 is available');
  if (languages.some(l => l.name === 'Rust')) runtimeHints.push('Rust project - cargo available for build/test');
  if (languages.some(l => l.name === 'Go')) runtimeHints.push('Go project - go toolchain available');

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'project.detect',
    decision: 'allow',
    result: `languages=${languages.length} frameworks=${frameworks.join(',') || 'none'} pm=${packageManager || 'none'} argsHash=${argsHash}`
  });

  return { languages, frameworks, packageManager, runtimeHints, monorepo, scripts, entryPoints, testFramework, ci, configFiles };
}