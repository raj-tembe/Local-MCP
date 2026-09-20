import { describe, it, expect } from 'vitest';
import { loadConfig, resolveConfigPath, defaultConfig } from './config.js';

describe('config loader', () => {
  it('returns safe defaults', () => {
    const cfg = loadConfig({ transport: 'stdio' });
    expect(cfg.transport).toBe('stdio');
    expect(cfg.security.defaultMode).toBe('ask');
    expect(cfg.security.allowedCommands).toContain('ls');
    expect(cfg.security.deniedCommands).toContain('sudo');
  });

  it('creates a config path with absolute home expansion', () => {
    const value = resolveConfigPath('~/.local-mcp/audit.jsonl');
    expect(value.startsWith('/')).toBe(true);
    expect(value.includes('audit.jsonl')).toBe(true);
  });

  it('includes default config values', () => {
    expect(defaultConfig.security.maxCommandLength).toBeGreaterThan(0);
    expect(defaultConfig.transport).toBe('stdio');
  });

  describe('auth config', () => {
    it('has default auth config with requireAuth false', () => {
      expect(defaultConfig.auth.requireAuth).toBe(false);
      expect(defaultConfig.auth.apiKeys).toEqual([]);
      expect(defaultConfig.auth.oauth.enabled).toBe(false);
    });

    it('loads auth config from overrides', () => {
      const cfg = loadConfig({
        auth: { requireAuth: true, apiKeys: ['key1', 'key2'], oauth: { enabled: false, clientId: '', clientSecret: '', issuerUrl: '', audience: '' } }
      });
      expect(cfg.auth.requireAuth).toBe(true);
      expect(cfg.auth.apiKeys).toEqual(['key1', 'key2']);
    });
  });

  describe('toolFilter config', () => {
    it('has default toolFilter with denied tools', () => {
      expect(defaultConfig.toolFilter.deniedTools).toContain('shell.execute');
      expect(defaultConfig.toolFilter.deniedTools).toContain('fs.write');
      expect(defaultConfig.toolFilter.allowedTools).toEqual([]);
    });

    it('loads toolFilter config from overrides', () => {
      const cfg = loadConfig({
        toolFilter: { allowedTools: ['fs.read', 'fs.list'], deniedTools: [] }
      });
      expect(cfg.toolFilter.allowedTools).toEqual(['fs.read', 'fs.list']);
      expect(cfg.toolFilter.deniedTools).toEqual([]);
    });
  });

  describe('env overrides', () => {
    it('reads LOCAL_MCP_API_KEYS', () => {
      process.env.LOCAL_MCP_API_KEYS = 'key1,key2,key3';
      try {
        const cfg = loadConfig({});
        expect(cfg.auth.apiKeys).toEqual(['key1', 'key2', 'key3']);
        expect(cfg.auth.requireAuth).toBe(true);
      } finally {
        delete process.env.LOCAL_MCP_API_KEYS;
      }
    });

    it('reads LOCAL_MCP_REQUIRE_AUTH', () => {
      process.env.LOCAL_MCP_REQUIRE_AUTH = 'true';
      try {
        const cfg = loadConfig({});
        expect(cfg.auth.requireAuth).toBe(true);
      } finally {
        delete process.env.LOCAL_MCP_REQUIRE_AUTH;
      }
    });

    it('reads LOCAL_MCP_ALLOWED_TOOLS', () => {
      process.env.LOCAL_MCP_ALLOWED_TOOLS = 'fs.read,fs.list';
      try {
        const cfg = loadConfig({});
        expect(cfg.toolFilter.allowedTools).toEqual(['fs.read', 'fs.list']);
      } finally {
        delete process.env.LOCAL_MCP_ALLOWED_TOOLS;
      }
    });

    it('reads LOCAL_MCP_DENIED_TOOLS', () => {
      process.env.LOCAL_MCP_DENIED_TOOLS = 'shell.execute,fs.write';
      try {
        const cfg = loadConfig({});
        expect(cfg.toolFilter.deniedTools).toEqual(['shell.execute', 'fs.write']);
      } finally {
        delete process.env.LOCAL_MCP_DENIED_TOOLS;
      }
    });
  });
});
