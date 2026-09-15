import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ApprovalStore from './store.js';

test('ApprovalStore set/get/list/clear', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-mcp-'));
  const filePath = path.join(tmpDir, 'approvals.json');
  const store = new ApprovalStore(filePath);

  // initially empty
  const list0 = await store.list();
  expect(list0).toEqual({});

  await store.set('tool:cmd', 'allow');
  const got = await store.get('tool:cmd');
  expect(got).toBeDefined();
  expect(got!.decision).toBe('allow');

  const list1 = await store.list();
  expect(list1['tool:cmd']).toBeDefined();

  await store.clear();
  const list2 = await store.list();
  expect(list2).toEqual({});

  // cleanup
  await fs.rm(tmpDir, { recursive: true, force: true });
});
