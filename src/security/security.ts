import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ApprovalStore from './store.js';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { type AppConfig } from '../config/config.js';

export type PermissionMode = 'ask' | 'allow' | 'deny';

export type AuthorizationDecision = {
  allowed: boolean;
  mode: PermissionMode;
  reason?: string;
  decision?: 'allow' | 'deny';
};

export class SecurityEngine {
  private readonly approvalCache = new Map<string, 'allow' | 'deny'>();
  private readonly store: ApprovalStore;

  constructor(private readonly config: AppConfig) {
    this.store = new ApprovalStore();
  }

  static normalizeCommand(command: string): string {
    return command.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  }

  static resolvePath(value: string): string {
    if (!value) {
      return process.cwd();
    }
    if (value.startsWith('~')) {
      return path.join(os.homedir(), value.slice(1));
    }
    return path.resolve(value);
  }

  private matchesAny(target: string, patterns: string[]): boolean {
    return patterns.some((pattern) => {
      if (!pattern) return false;
      const normalized = pattern.startsWith('~') ? path.join(os.homedir(), pattern.slice(1)) : pattern;
      return target === normalized || target.startsWith(`${normalized}${path.sep}`) || target.startsWith(normalized);
    });
  }

  private getDecisionKey(toolName: string, details: Record<string, unknown>): string {
    const keyParts: string[] = [toolName];
    const command = typeof details.command === 'string' ? details.command : undefined;
    const toolPath = typeof details.path === 'string' ? details.path : typeof details.filePath === 'string' ? details.filePath : undefined;
    const sessionId = typeof details.sessionId === 'string' ? details.sessionId : undefined;

    if (command) keyParts.push(`command:${SecurityEngine.normalizeCommand(command)}`);
    if (toolPath) keyParts.push(`path:${SecurityEngine.resolvePath(toolPath)}`);
    if (sessionId) keyParts.push(`session:${sessionId}`);

    return keyParts.join(':');
  }

  private getCachedDecision(toolName: string, details: Record<string, unknown>): AuthorizationDecision | undefined {
    const key = this.getDecisionKey(toolName, details);
    const cached = this.approvalCache.get(key);
    if (!cached) return undefined;
    return {
      allowed: cached === 'allow',
      mode: cached === 'allow' ? 'allow' : 'deny',
      decision: cached,
      reason: cached === 'allow' ? 'Cached approval' : 'Cached denial'
    };
  }

  private rememberDecision(toolName: string, details: Record<string, unknown>, decision: 'allow' | 'deny'): void {
    const key = this.getDecisionKey(toolName, details);
    this.approvalCache.set(key, decision);
    // persist asynchronously, best-effort
    void this.store.set(key, decision).catch(() => { /* ignore persistence errors */ });
  }

  shouldRequireApproval(toolName: string): boolean {
    return this.config.security.requireApproval.includes(toolName);
  }

  checkToolAllowed(toolName: string): { allowed: boolean; reason?: string } {
    const { allowedTools, deniedTools } = this.config.toolFilter;

    if (allowedTools.length > 0) {
      if (!allowedTools.includes(toolName)) {
        return { allowed: false, reason: `Tool '${toolName}' is not in the allowed tools list.` };
      }
      return { allowed: true };
    }

    if (deniedTools.includes(toolName)) {
      return { allowed: false, reason: `Tool '${toolName}' is denied by tool filter policy.` };
    }

    return { allowed: true };
  }

  checkCommand(command: string): { allowed: boolean; reason?: string } {
    const cmd = SecurityEngine.normalizeCommand(command);

    if (this.config.security.deniedCommands.includes(cmd)) {
      return { allowed: false, reason: `Command '${cmd}' is denied by policy.` };
    }

    if (this.config.security.allowedCommands.length > 0 && !this.config.security.allowedCommands.includes(cmd)) {
      return { allowed: false, reason: `Command '${cmd}' is not in the allowlist.` };
    }

    if (command.length > this.config.security.maxCommandLength) {
      return { allowed: false, reason: `Command exceeds the configured max length (${this.config.security.maxCommandLength}).` };
    }

    return { allowed: true };
  }

  checkPath(target: string): { allowed: boolean; reason?: string } {
    const resolved = SecurityEngine.resolvePath(target);
    const denied = this.config.security.deniedPaths;
    if (this.matchesAny(resolved, denied)) {
      return { allowed: false, reason: `Path '${target}' is denied by policy.` };
    }

    const allowed = this.config.security.allowedPaths;
    if (Array.isArray(allowed) && allowed.length > 0 && !this.matchesAny(resolved, allowed)) {
      return { allowed: false, reason: `Path '${target}' is outside the configured allowlist.` };
    }

    return { allowed: true };
  }

  async requestApproval(toolName: string, details: Record<string, unknown>): Promise<AuthorizationDecision> {
    const mode = this.config.security.defaultMode;
    if (mode === 'allow') {
      const decision = { allowed: true, mode, decision: 'allow' as const };
      this.rememberDecision(toolName, details, 'allow');
      return decision;
    }
    if (mode === 'deny') {
      const decision = { allowed: false, mode, decision: 'deny' as const, reason: 'Policy default is deny.' };
      this.rememberDecision(toolName, details, 'deny');
      return decision;
    }

    const summary = JSON.stringify(details, null, 2).replace(/"token"\s*:\s*"[^"]+"/gi, '"token":"[REDACTED]"');
    if (!process.stdin.isTTY) {
      const decision = { allowed: false, mode, decision: 'deny' as const, reason: 'Interactive approval requested but no TTY is available.' };
      this.rememberDecision(toolName, details, 'deny');
      return decision;
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(`[Local-MCP] AI requests: ${toolName}\n${summary}\nAllow? (y/N/always/deny) `, (value) => {
        resolve(value.trim().toLowerCase());
      });
    });
    rl.close();

    const normalized = answer || 'n';
    if (normalized === 'y' || normalized === 'yes' || normalized === 'always') {
      const decision = { allowed: true, mode: 'allow' as const, decision: 'allow' as const };
      this.rememberDecision(toolName, details, 'allow');
      return decision;
    }

    const decision = { allowed: false, mode: 'deny' as const, decision: 'deny' as const, reason: 'User denied the operation.' };
    this.rememberDecision(toolName, details, 'deny');
    return decision;
  }

  async authorize(toolName: string, details: Record<string, unknown>): Promise<AuthorizationDecision> {
    const cached = this.getCachedDecision(toolName, details);
    if (cached) return cached;

    const toolCheck = this.checkToolAllowed(toolName);
    if (!toolCheck.allowed) {
      return { allowed: false, mode: 'deny', decision: 'deny', reason: toolCheck.reason };
    }

    const command = typeof details.command === 'string' ? details.command : undefined;
    const targetPath = typeof details.path === 'string' ? details.path : typeof details.filePath === 'string' ? details.filePath : undefined;
    const cwd = typeof details.cwd === 'string' ? details.cwd : undefined;

    if (command) {
      const commandCheck = this.checkCommand(command);
      if (!commandCheck.allowed) {
        return { allowed: false, mode: 'deny', decision: 'deny', reason: commandCheck.reason };
      }
    }

    if (targetPath) {
      const pathCheck = this.checkPath(targetPath);
      if (!pathCheck.allowed) {
        return { allowed: false, mode: 'deny', decision: 'deny', reason: pathCheck.reason };
      }
    }

    if (cwd) {
      const cwdCheck = this.checkPath(cwd);
      if (!cwdCheck.allowed) {
        return { allowed: false, mode: 'deny', decision: 'deny', reason: cwdCheck.reason };
      }
    }

    // check persistent approvals (user-granted decisions stored on disk)
    try {
      const key = this.getDecisionKey(toolName, details);
      const stored = await this.store.get(key);
      if (stored) {
        const d = stored.decision;
        return { allowed: d === 'allow', mode: d === 'allow' ? 'allow' : 'deny', decision: d, reason: 'Persistent approval' };
      }
    } catch {
      // ignore store errors and continue to interactive prompt if needed
    }

    if (this.shouldRequireApproval(toolName)) {
      return this.requestApproval(toolName, details);
    }

    return { allowed: true, mode: 'allow', decision: 'allow' };
  }
}

export function createSessionId(): string {
  return randomUUID();
}

export function ensureAuditDirectory(filePath: string): string {
  const resolved = filePath.startsWith('~') ? path.join(os.homedir(), filePath.slice(1)) : path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}
