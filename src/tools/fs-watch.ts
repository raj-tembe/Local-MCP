import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SecurityEngine } from '../security/security.js';
import { AuditLogger } from '../audit/audit.js';

const MAX_WATCHERS = 8;
const MAX_EVENTS_PER_WATCHER = 1000;
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'target', 'vendor', '__pycache__', '.venv', 'venv', '.idea', '.vscode']);

interface WatchEntry {
  id: string;
  path: string;
  events: Set<'add' | 'change' | 'unlink'>;
  debounceMs: number;
  buffer: Array<{ type: 'add' | 'change' | 'unlink'; path: string; at: number }>;
  cursor: number;
  watcher: fs.FSWatcher | null;
  debounceTimer: NodeJS.Timeout | null;
  dropped: number;
}

const watchers = new Map<string, WatchEntry>();

function expandPath(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

function shouldIgnore(filePath: string): boolean {
  const parts = filePath.split(path.sep);
  for (const part of parts) {
    if (IGNORED_DIRS.has(part)) return true;
  }
  return false;
}

function cleanupWatcher(id: string): void {
  const entry = watchers.get(id);
  if (entry) {
    if (entry.watcher) {
      try { entry.watcher.close(); } catch {}
    }
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    watchers.delete(id);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of watchers.entries()) {
    if (now - entry.cursor > 3600000) {
      cleanupWatcher(id);
    }
  }
}, 300000).unref();

process.on('exit', () => {
  for (const id of watchers.keys()) {
    cleanupWatcher(id);
  }
});

export interface FsWatchResult {
  watchId: string;
  path: string;
  [key: string]: unknown;
}

export interface FsWatchPollResult {
  changes: Array<{ type: 'add' | 'change' | 'unlink'; path: string; at: number }>;
  cursor: number;
  [key: string]: unknown;
}

export interface FsUnwatchResult {
  closed: boolean;
  [key: string]: unknown;
}

export async function runFsWatch(
  config: {
    path: string;
    events?: ('add' | 'change' | 'unlink')[];
    debounceMs?: number;
    sessionId?: string;
  },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<FsWatchResult> {
  const targetPath = expandPath(config.path);

  const decision = await security.authorize('fs.watch', { path: targetPath });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  if (watchers.size >= MAX_WATCHERS) {
    throw new Error(`Maximum concurrent watchers (${MAX_WATCHERS}) reached`);
  }

  const watchId = createHash('sha256').update(`${targetPath}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 16);
  const events = new Set<('add' | 'change' | 'unlink')>(config.events ?? ['add', 'change', 'unlink']);
  const debounceMs = config.debounceMs ?? 250;

  const entry: WatchEntry = {
    id: watchId,
    path: targetPath,
    events,
    debounceMs,
    buffer: [],
    cursor: Date.now(),
    watcher: null,
    debounceTimer: null,
    dropped: 0
  };

  const tryEmit = (entry: WatchEntry) => {
    if (entry.buffer.length > 0) {
      entry.cursor = Date.now();
    }
  };

  const watcher = fs.watch(targetPath, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    const fullPath = path.join(targetPath, filename);
    if (shouldIgnore(fullPath)) return;
    const type = eventType === 'rename' ? 'unlink' : eventType === 'change' ? 'change' : 'add';
    if (!entry.events.has(type)) return;
    entry.buffer.push({ type, path: fullPath, at: Date.now() });
    if (entry.buffer.length > MAX_EVENTS_PER_WATCHER) {
      entry.dropped++;
      entry.buffer.shift();
    }
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => tryEmit(entry), debounceMs);
  });

  watcher.on('error', (err) => {
    console.error(`Watcher error for ${watchId}:`, err);
  });

  entry.watcher = watcher;
  watchers.set(watchId, entry);

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'fs.watch',
    decision: 'allow',
    result: `watchId=${watchId} path=${targetPath} argsHash=${argsHash}`
  });

  return { watchId, path: targetPath };
}

export async function runFsWatchPoll(
  config: { watchId: string; since?: number },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<FsWatchPollResult> {
  const entry = watchers.get(config.watchId);
  if (!entry) {
    throw new Error(`Watcher not found: ${config.watchId}`);
  }

  const since = config.since ?? 0;
  const changes = entry.buffer.filter(e => e.at > since);

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'fs.watch.poll',
    decision: 'allow',
    result: `watchId=${config.watchId} changes=${changes.length} dropped=${entry.dropped} argsHash=${argsHash}`
  });

  return { changes, cursor: entry.cursor };
}

export async function runFsUnwatch(
  config: { watchId: string },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<FsUnwatchResult> {
  const decision = await security.authorize('fs.unwatch', { watchId: config.watchId });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  const entry = watchers.get(config.watchId);
  if (!entry) {
    return { closed: false };
  }

  cleanupWatcher(config.watchId);

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'fs.unwatch',
    decision: 'allow',
    result: `watchId=${config.watchId} argsHash=${argsHash}`
  });

  return { closed: true };
}