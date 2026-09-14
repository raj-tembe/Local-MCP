import fs from 'node:fs';
import { ensureAuditDirectory } from '../security/security.js';

export type AuditEntry = Record<string, unknown> & {
  timestamp: string;
  sessionId?: string;
  tool: string;
  decision: 'allow' | 'deny';
  result?: string;
};

export class AuditLogger {
  constructor(private readonly filePath: string) {}

  redact(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === 'string') {
      return value
        .replace(/(token|secret|password|authorization|api[_-]?key)/gi, '[REDACTED]')
        .replace(/(Bearer\s+[A-Za-z0-9._-]+)/gi, '[REDACTED]');
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.redact(item));
    }

    if (typeof value === 'object') {
      const output: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (/token|secret|password|authorization|api[_-]?key/i.test(key)) {
          output[key] = '[REDACTED]';
        } else {
          output[key] = this.redact(entry);
        }
      }
      return output;
    }

    return value;
  }

  log(entry: AuditEntry): void {
    const resolvedPath = ensureAuditDirectory(this.filePath);
    const payload = {
      ...entry,
      timestamp: entry.timestamp ?? new Date().toISOString()
    };
    const toWrite = `${JSON.stringify(this.redact(payload))}\n`;
    fs.appendFileSync(resolvedPath, toWrite, 'utf8');
  }
}
