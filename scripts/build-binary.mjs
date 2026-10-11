#!/usr/bin/env node
// Builds a standalone Local-MCP executable for the platform this script runs on:
//
//   npm run build:binary   ->  dist-bin/local-mcp-<platform>-<arch>[.exe]
//
// How it works: esbuild bundles the CLI and its JavaScript dependencies into a single CommonJS
// file, Node's single-executable-application (SEA) support packs that file into a blob, and the
// blob is injected into a copy of the `node` binary that is running this script. The result runs
// on machines without Node.js or npm. A binary only runs on the OS/CPU it was built on, so each
// target is built on its own runner (see .github/workflows/release.yml).
//
// The optional node-pty native module is deliberately NOT bundled: native addons cannot be loaded
// from inside a single executable, so PTY terminal sessions (terminal.create) report "not
// available" in binary builds. Every other tool works.

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const { platform, arch } = process;
const exe = platform === 'win32' ? '.exe' : '';
const buildDir = path.join(root, 'build-bin');
const outDir = path.join(root, 'dist-bin');
const bundlePath = path.join(buildDir, 'local-mcp.cjs');
const configPath = path.join(buildDir, 'sea-config.json');
const blobPath = path.join(buildDir, 'sea-prep.blob');
const outPath = path.join(outDir, `local-mcp-${platform}-${arch}${exe}`);

const major = Number.parseInt(process.versions.node.split('.')[0], 10);
if (major < 20) {
  console.error(`Node.js 20 or newer is required to build the binary (running ${process.version}).`);
  process.exit(1);
}

const run = (file, args) => execFileSync(file, args, { stdio: 'inherit' });

fs.rmSync(buildDir, { recursive: true, force: true });
fs.mkdirSync(buildDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

console.log('1/4 Bundling with esbuild...');
await build({
  entryPoints: [path.join(root, 'src', 'cli.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: `node${major}`,
  // Native or optional modules that must not be bundled.
  external: ['node-pty', 'bufferutil', 'utf-8-validate'],
  // `import.meta` does not exist in a CommonJS bundle; the PTY loader treats this as "not bundled".
  define: { 'import.meta.url': 'undefined' },
  legalComments: 'none',
  logLevel: 'warning'
});
// A hashbang is valid for the CLI file but not needed inside the SEA blob.
const bundled = fs.readFileSync(bundlePath, 'utf8');
if (bundled.startsWith('#!')) fs.writeFileSync(bundlePath, bundled.slice(bundled.indexOf('\n') + 1));

console.log('2/4 Preparing the SEA blob...');
fs.writeFileSync(configPath, JSON.stringify({
  main: bundlePath,
  output: blobPath,
  disableExperimentalSEAWarning: true
}));
run(process.execPath, ['--experimental-sea-config', configPath]);

console.log('3/4 Copying the node binary and injecting the blob...');
fs.copyFileSync(process.execPath, outPath);
fs.chmodSync(outPath, 0o755);
if (platform === 'darwin') {
  run('codesign', ['--remove-signature', outPath]);
}
const postjectPkg = require('postject/package.json');
const postjectBin = path.join(path.dirname(require.resolve('postject/package.json')),
  typeof postjectPkg.bin === 'string' ? postjectPkg.bin : Object.values(postjectPkg.bin)[0]);
run(process.execPath, [
  postjectBin, outPath, 'NODE_SEA_BLOB', blobPath,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [])
]);

console.log('4/4 Finishing...');
if (platform === 'darwin') {
  // Apple Silicon refuses to run unsigned binaries; an ad-hoc signature is enough to run locally.
  // Distribute with a Developer ID signature and notarization to avoid Gatekeeper prompts.
  run('codesign', ['--sign', '-', outPath]);
}
const sizeMb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
console.log(`\nBuilt ${path.relative(root, outPath)} (${sizeMb} MB)`);
