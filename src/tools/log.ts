import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SecurityEngine } from '../security/security.js';
import { AuditLogger } from '../audit/audit.js';

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_LINES = 100;
const MAX_LINES = 5000;

function expandPath(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

export interface LogTailResult {
  lines: string[];
  cursor: number;
  truncated: boolean;
  [key: string]: unknown;
}

export async function runLogTail(
  config: {
    path: string;
    lines?: number;
    cursor?: number;
    maxBytes?: number;
  },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<LogTailResult> {
  const filePath = expandPath(config.path);

  const decision = await security.authorize('log.tail', { path: filePath });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  const maxLines = Math.min(config.lines ?? DEFAULT_LINES, MAX_LINES);
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
  const cursor = config.cursor ?? 0;

  let fileHandle: import('node:fs/promises').FileHandle | null = null;
  try {
    fileHandle = await fsp.open(filePath, 'r');
    const stat = await fileHandle.stat();
    if (cursor >= stat.size) {
      return { lines: [], cursor: stat.size, truncated: false };
    }

    const startPos = cursor;
    const endPos = Math.min(stat.size, startPos + maxBytes);
    const bytesToRead = endPos - startPos;

    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, startPos);
    const text = buffer.subarray(0, bytesRead).toString('utf8');

    const allLines = text.split('\n');
    const lines = allLines.slice(-maxLines);
    const truncated = bytesRead < bytesToRead && lines.length < allLines.length;

    const newCursor = startPos + bytesRead;

    const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
    audit.log({
      timestamp: new Date().toISOString(),
      sessionId,
      tool: 'log.tail',
      decision: 'allow',
      result: `path=${filePath} lines=${lines.length} cursor=${newCursor} truncated=${truncated} argsHash=${argsHash}`
    });

    return { lines, cursor: newCursor, truncated };
  } finally {
    if (fileHandle) await fileHandle.close().catch(() => {});
  }
}