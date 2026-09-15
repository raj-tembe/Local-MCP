import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export type Connector = {
  name: string;
  url: string;
  description?: string;
  createdAt: number;
};

export class ConnectorsStore {
  private file: string;
  private cache: Record<string, Connector> | null = null;

  constructor(filePath?: string) {
    const defaultPath = path.join(os.homedir(), '.local-mcp', 'connectors.json');
    this.file = filePath ?? defaultPath;
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

  async list(): Promise<Connector[]> {
    await this.ensureLoaded();
    return Object.values(this.cache ?? {});
  }

  async get(name: string): Promise<Connector | undefined> {
    await this.ensureLoaded();
    return this.cache![name];
  }

  async add(name: string, url: string, description?: string): Promise<Connector> {
    await this.ensureLoaded();
    const c: Connector = { name, url, description, createdAt: Date.now() };
    this.cache![name] = c;
    await fs.writeFile(this.file, JSON.stringify(this.cache, null, 2), 'utf8');
    return c;
  }

  async remove(name: string): Promise<boolean> {
    await this.ensureLoaded();
    if (!this.cache![name]) return false;
    delete this.cache![name];
    await fs.writeFile(this.file, JSON.stringify(this.cache, null, 2), 'utf8');
    return true;
  }

  async clear(): Promise<void> {
    this.cache = {};
    await fs.writeFile(this.file, JSON.stringify(this.cache, null, 2), 'utf8');
  }
}

export default ConnectorsStore;
