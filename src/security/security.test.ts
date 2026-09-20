import { describe, it, expect } from 'vitest';
import { SecurityEngine } from './security.js';
import { defaultConfig, loadConfig } from '../config/config.js';

describe('security engine', () => {
  it('blocks denied commands', () => {
    const engine = new SecurityEngine(defaultConfig);
    expect(engine.checkCommand('rm -rf /tmp/test')).toMatchObject({ allowed: false });
  });

  it('blocks disallowed paths', () => {
    const engine = new SecurityEngine(defaultConfig);
    expect(engine.checkPath('/etc/passwd')).toMatchObject({ allowed: false });
  });

  it('allows safe commands from the allowlist', () => {
    const engine = new SecurityEngine(defaultConfig);
    expect(engine.checkCommand('echo hello')).toMatchObject({ allowed: true });
  });

  describe('tool filtering', () => {
    it('denies tools in deniedTools list by default', () => {
      const engine = new SecurityEngine(defaultConfig);
      expect(engine.checkToolAllowed('shell.execute')).toMatchObject({ allowed: false });
      expect(engine.checkToolAllowed('fs.write')).toMatchObject({ allowed: false });
      expect(engine.checkToolAllowed('terminal.write')).toMatchObject({ allowed: false });
    });

    it('allows tools not in deniedTools list', () => {
      const engine = new SecurityEngine(defaultConfig);
      expect(engine.checkToolAllowed('fs.read')).toMatchObject({ allowed: true });
      expect(engine.checkToolAllowed('fs.list')).toMatchObject({ allowed: true });
      expect(engine.checkToolAllowed('system.info')).toMatchObject({ allowed: true });
    });

    it('allows tools when allowedTools is configured and tool is in list', () => {
      const config = loadConfig({
        toolFilter: { allowedTools: ['shell.execute', 'fs.read'], deniedTools: [] }
      });
      const engine = new SecurityEngine(config);
      expect(engine.checkToolAllowed('shell.execute')).toMatchObject({ allowed: true });
      expect(engine.checkToolAllowed('fs.read')).toMatchObject({ allowed: true });
      expect(engine.checkToolAllowed('fs.write')).toMatchObject({ allowed: false });
    });

    it('denies tools when allowedTools is configured and tool is not in list', () => {
      const config = loadConfig({
        toolFilter: { allowedTools: ['fs.read'], deniedTools: [] }
      });
      const engine = new SecurityEngine(config);
      expect(engine.checkToolAllowed('fs.read')).toMatchObject({ allowed: true });
      expect(engine.checkToolAllowed('shell.execute')).toMatchObject({ allowed: false });
    });

    it('allowedTools takes precedence over deniedTools', () => {
      const config = loadConfig({
        toolFilter: { allowedTools: ['shell.execute'], deniedTools: ['shell.execute'] }
      });
      const engine = new SecurityEngine(config);
      expect(engine.checkToolAllowed('shell.execute')).toMatchObject({ allowed: true });
    });
  });
});
