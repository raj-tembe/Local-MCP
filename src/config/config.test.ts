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
});
