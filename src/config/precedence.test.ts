import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, envOverrides } from './config.js';
import { buildStartConfig } from './startConfig.js';

const ENV_KEYS = [
  'LOCAL_MCP_TRANSPORT', 'LOCAL_MCP_PORT', 'LOCAL_MCP_DEFAULT_MODE', 'LOCAL_MCP_APPROVAL_TIMEOUT_MS',
  'LOCAL_MCP_AUDIT_FILE', 'LOCAL_MCP_API_KEYS', 'LOCAL_MCP_REQUIRE_AUTH', 'LOCAL_MCP_ALLOWED_TOOLS', 'LOCAL_MCP_DENIED_TOOLS',
  'LOCAL_MCP_RELAY_URL', 'LOCAL_MCP_TOKEN'
];

let tempHome: string;
let saved: Record<string, string | undefined>;
let originalCwd: string;

function writeUserConfig(config: unknown) {
  fs.mkdirSync(path.join(tempHome, '.local-mcp'), { recursive: true });
  fs.writeFileSync(path.join(tempHome, '.local-mcp', 'config.json'), JSON.stringify(config));
}

beforeEach(() => {
  saved = { HOME: process.env.HOME };
  for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  originalCwd = process.cwd();
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mcp-cfg-home-'));
  process.env.HOME = tempHome;
  process.chdir(tempHome); // no project-level config files here
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe('config precedence', () => {
  it('start honours the config file when no flags are given', () => {
    writeUserConfig({ transport: 'sse', port: 4321, security: { allowedCommands: ['python3', 'node'], approvalTimeoutMs: 9000 } });
    const cfg = buildStartConfig({});
    expect(cfg.transport).toBe('sse');
    expect(cfg.port).toBe(4321);
    expect(cfg.security.allowedCommands).toEqual(['python3', 'node']);
    expect(cfg.security.approvalTimeoutMs).toBe(9000);
  });

  it('command-line flags beat the config file', () => {
    writeUserConfig({ transport: 'stdio', port: 4321 });
    const cfg = buildStartConfig({ transport: 'sse', port: '5555' });
    expect(cfg.transport).toBe('sse');
    expect(cfg.port).toBe(5555);
  });

  it('start honours environment variables', () => {
    process.env.LOCAL_MCP_APPROVAL_TIMEOUT_MS = '1234';
    process.env.LOCAL_MCP_DEFAULT_MODE = 'deny';
    const cfg = buildStartConfig({ transport: 'sse' });
    expect(cfg.security.approvalTimeoutMs).toBe(1234);
    expect(cfg.security.defaultMode).toBe('deny');
  });

  it('falls back to stdio with nothing configured', () => {
    expect(buildStartConfig({}).transport).toBe('stdio');
  });

  it('an env var does not wipe other settings from the same config section', () => {
    writeUserConfig({
      security: { allowedCommands: ['python3'], deniedCommands: ['sudo'] },
      logging: { level: 'debug' },
      auth: { apiKeys: ['file-key'], requireAuth: true },
      toolFilter: { deniedTools: ['fs.write'] }
    });
    process.env.LOCAL_MCP_DEFAULT_MODE = 'allow';
    process.env.LOCAL_MCP_AUDIT_FILE = '/tmp/custom-audit.jsonl';
    process.env.LOCAL_MCP_REQUIRE_AUTH = 'true';
    process.env.LOCAL_MCP_ALLOWED_TOOLS = 'fs.read';
    const cfg = loadConfig();
    expect(cfg.security.defaultMode).toBe('allow');
    expect(cfg.security.allowedCommands).toEqual(['python3']);
    expect(cfg.security.deniedCommands).toEqual(['sudo']);
    expect(cfg.logging.auditFile).toBe('/tmp/custom-audit.jsonl');
    expect(cfg.logging.level).toBe('debug');
    expect(cfg.auth.apiKeys).toEqual(['file-key']);
    expect(cfg.toolFilter.allowedTools).toEqual(['fs.read']);
    expect(cfg.toolFilter.deniedTools).toEqual(['fs.write']);
  });

  it('envOverrides only returns the fields that were set', () => {
    process.env.LOCAL_MCP_APPROVAL_TIMEOUT_MS = '500';
    expect(envOverrides()).toEqual({ security: { approvalTimeoutMs: 500 } });
  });

  it('accepts 0 to disable the approval timeout and ignores garbage', () => {
    process.env.LOCAL_MCP_APPROVAL_TIMEOUT_MS = '0';
    expect(loadConfig().security.approvalTimeoutMs).toBe(0);
    process.env.LOCAL_MCP_APPROVAL_TIMEOUT_MS = 'soon';
    expect(loadConfig().security.approvalTimeoutMs).toBe(60000);
  });
});
