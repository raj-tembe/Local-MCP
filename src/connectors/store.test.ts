import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ConnectorsStore from './store.js';

test('ConnectorsStore add/list/remove', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-mcp-conn-'));
  const filePath = path.join(tmpDir, 'connectors.json');
  const store = new ConnectorsStore(filePath);

  const initial = await store.list();
  expect(Array.isArray(initial)).toBe(true);
  expect(initial.length).toBe(0);

  const added = await store.add('example', 'https://mcp.example.com/mcp', 'Example connector');
  expect(added.name).toBe('example');
  expect(added.url).toBe('https://mcp.example.com/mcp');

  const listed = await store.list();
  expect(listed.length).toBe(1);

  const ok = await store.remove('example');
  expect(ok).toBe(true);

  const after = await store.list();
  expect(after.length).toBe(0);

  await fs.rm(tmpDir, { recursive: true, force: true });
});
