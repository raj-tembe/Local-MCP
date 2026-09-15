import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export type StoredDecision = {
  decision: 'allow' | 'deny';
  ts: number;
};

export class ApprovalStore {
  private file: string;
  private cache: Record<string, StoredDecision> | null = null;

  constructor(filePath?: string) {
    const defaultPath = path.join(os.homedir(), '.local-mcp', 'approvals.json');
    this.file = filePath ? filePath : defaultPath;
  }

  private async ensureLoaded() {
    if (this.cache !== null) return;
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      this.cache = raw ? JSON.parse(raw) : {};
    } catch (err) {
      this.cache = {};
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await fs.writeFile(this.file, JSON.stringify(this.cache, null, 2), 'utf8');
      } catch {}
    }
  }

  async get(key: string): Promise<StoredDecision | undefined> {
    await this.ensureLoaded();
    return this.cache![key];
  }

  async set(key: string, decision: 'allow' | 'deny'): Promise<void> {
    await this.ensureLoaded();
    this.cache![key] = { decision, ts: Date.now() };
    await fs.writeFile(this.file, JSON.stringify(this.cache, null, 2), 'utf8');
  }

  async list(): Promise<Record<string, StoredDecision>> {
    await this.ensureLoaded();
    return { ...(this.cache ?? {}) };
  }

  async clear(): Promise<void> {
    this.cache = {};
    await fs.writeFile(this.file, JSON.stringify(this.cache, null, 2), 'utf8');
  }
}

export default ApprovalStore;
