import { describe, it, expect } from 'vitest';
import { SecurityEngine } from './security.js';
import { defaultConfig } from '../config/config.js';

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
});
