import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import express from 'express';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { statSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type AppConfig, defaultConfig } from '../config/config.js';
import { SecurityEngine, createSessionId } from '../security/security.js';
import { AuditLogger } from '../audit/audit.js';
import { TerminalManager } from '../terminal/manager.js';
import ConnectorsStore from '../connectors/store.js';
import { randomUUID, createHash } from 'node:crypto';
import { runProcess, clampTimeout, type RunResult } from '../exec/run.js';
import { SUPPORTED_LANGUAGES, findExecutable, resolveLanguage, runCode } from '../exec/code.js';
import { PACKAGE_MANAGERS, buildInstallPlan } from '../exec/packages.js';
import { sharedProcessManager, summarize as summarizeProcess, installExitCleanup } from '../process/manager.js';

const execAsync = promisify(exec);

function verifyApiKey(config: AppConfig, req: any): boolean {
  if (!config.auth.requireAuth) return true;
  if (config.auth.apiKeys.length === 0) return true;

  const authHeader = req.headers.authorization;
  if (!authHeader) return false;

  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  return config.auth.apiKeys.includes(token);
}

function authMiddleware(config: AppConfig) {
  return (req: any, res: any, next: any) => {
    if (!verifyApiKey(config, req)) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Unauthorized: Invalid or missing API key' },
        id: req.body?.id ?? null
      });
      return;
    }
    next();
  };
}

const textContent = (text: string) => ({ type: 'text' as const, text });

function fingerprintOf(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}

function truncateForLog(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

function runResultToToolResult(result: RunResult, extra: Record<string, unknown> = {}) {
  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout.replace(/\n$/, ''));
  if (result.stderr) parts.push(`[stderr]\n${result.stderr.replace(/\n$/, '')}`);
  if (result.spawnError) parts.push(`[error] ${result.spawnError}`);
  if (result.timedOut) parts.push('[timed out and was killed]');
  if (result.truncated) parts.push('[output truncated]');
  parts.push(`[exit ${result.exitCode ?? result.signal ?? 'unknown'} in ${result.durationMs}ms]`);
  const failed = result.exitCode !== 0 || result.timedOut || Boolean(result.spawnError);
  return {
    content: [textContent(parts.join('\n'))],
    ...(failed ? { isError: true } : {}),
    structuredContent: {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      truncated: result.truncated,
      durationMs: result.durationMs,
      ...extra
    }
  };
}

function denyResult(reason: string, details?: Record<string, unknown>) {
  const payload: Record<string, unknown> = {
    ok: false,
    denied: true,
    reason,
    ...(details ?? {})
  };

  return {
    content: [textContent(JSON.stringify(payload, null, 2))],
    isError: true,
    structuredContent: payload
  };
}

async function executeShellCommand(
  config: AppConfig,
  security: SecurityEngine,
  audit: AuditLogger,
  command: string,
  cwd?: string,
  timeout?: number,
  extra?: { sessionId?: string }
) {
  const sessionId = extra?.sessionId ?? createSessionId();
  const decision = await security.authorize('shell.execute', { command, cwd });
  if (!decision.allowed) {
    audit.log({ timestamp: new Date().toISOString(), sessionId, tool: 'shell.execute', decision: 'deny', result: decision.reason ?? 'Denied' });
    return denyResult(decision.reason ?? 'Permission denied', { tool: 'shell.execute', sessionId, command, cwd });
  }

  try {
    const { stdout, stderr } = await execAsync(command, { cwd, timeout });
    audit.log({ timestamp: new Date().toISOString(), sessionId, tool: 'shell.execute', decision: 'allow', result: stdout || stderr || 'Command succeeded' });
    return {
      content: [textContent(`${stdout}${stderr}`)],
      structuredContent: { stdout, stderr, exitCode: 0 }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    audit.log({ timestamp: new Date().toISOString(), sessionId, tool: 'shell.execute', decision: 'allow', result: message });
    return { content: [textContent(message)], isError: true, structuredContent: { error: message } };
  }
}

export function createLocalMcpServer(config: AppConfig = defaultConfig): McpServer {
  const security = new SecurityEngine(config);
  const audit = new AuditLogger(config.logging.auditFile);
  const terminalManager = new TerminalManager();
  const connectors = new ConnectorsStore();
  const processes = sharedProcessManager;

  const server = new McpServer({
    name: 'local-mcp',
    version: '0.1.0'
  }, { capabilities: { logging: {} } });

  server.registerTool('terminal.create', {
    description: 'Start a new PTY session for interactive terminal access.',
    inputSchema: {
      shell: z.string().default('bash'),
      cwd: z.string().optional(),
      env: z.record(z.string()).optional()
    }
  }, async ({ shell, cwd, env }, extra) => {
    const sessionId = extra.sessionId ?? createSessionId();
    const decision = await security.authorize('terminal.create', { shell, cwd });
    if (!decision.allowed) {
      audit.log({ timestamp: new Date().toISOString(), sessionId, tool: 'terminal.create', decision: 'deny', result: decision.reason ?? 'Denied' });
      return denyResult(decision.reason ?? 'Permission denied', { tool: 'terminal.create', sessionId, shell, cwd });
    }

    const session = terminalManager.createSession(shell, { cwd, env });
    audit.log({ timestamp: new Date().toISOString(), sessionId: session.id, tool: 'terminal.create', decision: 'allow', result: `Session ${session.id} created` });
    return { content: [{ type: 'text', text: JSON.stringify({ id: session.id, shell, cwd: session.cwd }) }], structuredContent: { id: session.id, shell, cwd: session.cwd } };
  });

  server.registerTool('terminal.write', {
    description: 'Write input to an existing PTY session.',
    inputSchema: {
      sessionId: z.string(),
      input: z.string()
    }
  }, async ({ sessionId, input }) => {
    const decision = await security.authorize('terminal.write', { sessionId, input: '[REDACTED]' });
    if (!decision.allowed) {
      return denyResult(decision.reason ?? 'Permission denied', { tool: 'terminal.write', sessionId });
    }

    terminalManager.write(sessionId, input);
    return { content: [{ type: 'text', text: 'OK' }], structuredContent: { ok: true } };
  });

  server.registerTool('terminal.resize', {
    description: 'Resize an active PTY session.',
    inputSchema: { sessionId: z.string(), cols: z.number(), rows: z.number() }
  }, async ({ sessionId, cols, rows }) => {
    const decision = await security.authorize('terminal.resize', { sessionId, cols, rows });
    if (!decision.allowed) {
      return denyResult(decision.reason ?? 'Permission denied', { tool: 'terminal.resize', sessionId, cols, rows });
    }

    terminalManager.resize(sessionId, cols, rows);
    return { content: [{ type: 'text', text: 'OK' }], structuredContent: { ok: true } };
  });

  server.registerTool('terminal.kill', {
    description: 'Terminate an active PTY session.',
    inputSchema: { sessionId: z.string() }
  }, async ({ sessionId }) => {
    const decision = await security.authorize('terminal.kill', { sessionId });
    if (!decision.allowed) {
      return denyResult(decision.reason ?? 'Permission denied', { tool: 'terminal.kill', sessionId });
    }

    terminalManager.kill(sessionId);
    return { content: [{ type: 'text', text: 'Session terminated' }], structuredContent: { ok: true } };
  });

  server.registerTool('terminal.read', {
    description: 'Read the output buffer for a PTY session.',
    inputSchema: { sessionId: z.string() }
  }, async ({ sessionId }) => {
    const output = terminalManager.read(sessionId);
    return { content: [{ type: 'text', text: output }], structuredContent: { output } };
  });

  server.registerTool('terminal.list', {
    description: 'List active PTY sessions.',
    inputSchema: {}
  }, async () => {
    return { content: [{ type: 'text', text: JSON.stringify(terminalManager.listSessions(), null, 2) }], structuredContent: { sessions: terminalManager.listSessions() } };
  });

  server.registerTool('terminal.exec', {
    description: 'Alias for shell.execute for compatibility with terminal-oriented clients.',
    inputSchema: {
      command: z.string().describe('Command to execute'),
      cwd: z.string().optional().describe('Optional working directory'),
      timeout: z.number().optional().describe('Timeout in milliseconds')
    }
  }, async ({ command, cwd, timeout }, extra) => {
    return executeShellCommand(config, security, audit, command, cwd, timeout, extra);
  });

  server.registerTool('shell.execute', {
    description: 'Execute a command in a local shell, subject to approval and allowlists.',
    inputSchema: {
      command: z.string().describe('Command to execute'),
      cwd: z.string().optional().describe('Optional working directory'),
      timeout: z.number().optional().describe('Timeout in milliseconds')
    }
  }, async ({ command, cwd, timeout }, extra) => {
    return executeShellCommand(config, security, audit, command, cwd, timeout, extra);
  });

  server.registerTool('system.info', {
    description: 'Get basic system information',
    inputSchema: {}
  }, async () => {
    const osInfo = {
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd(),
      user: process.env.USER || process.env.USERNAME || 'unknown',
      release: process.version,
      totalmem: os.totalmem(),
      freemem: os.freemem(),
      hostname: os.hostname()
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(osInfo, null, 2) }],
      structuredContent: osInfo
    };
  });

  server.registerTool('fs.list', {
    description: 'List a directory',
    inputSchema: { path: z.string().default('.') }
  }, async ({ path: dir }) => {
    const decision = await security.authorize('fs.list', { path: dir });
    if (!decision.allowed) {
      return denyResult(decision.reason ?? 'Permission denied', { tool: 'fs.list', path: dir });
    }

    const entries = await fs.readdir(dir, { withFileTypes: true });
    return {
      content: [{ type: 'text', text: JSON.stringify(entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' })), null, 2) }],
      structuredContent: { entries: entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' })) }
    };
  });

  server.registerTool('fs.read', {
    description: 'Read a file from the filesystem.',
    inputSchema: { path: z.string() }
  }, async ({ path: filePath }) => {
    const decision = await security.authorize('fs.read', { path: filePath });
    if (!decision.allowed) {
      return denyResult(decision.reason ?? 'Permission denied', { tool: 'fs.read', path: filePath });
    }

    const text = await fs.readFile(filePath, 'utf8');
    return { content: [{ type: 'text', text }], structuredContent: { path: filePath, text } };
  });

  server.registerTool('fs.mkdir', {
    description: 'Create a directory recursively.',
    inputSchema: { path: z.string() }
  }, async ({ path: dirPath }) => {
    const decision = await security.authorize('fs.mkdir', { path: dirPath });
    if (!decision.allowed) {
      return denyResult(decision.reason ?? 'Permission denied', { tool: 'fs.mkdir', path: dirPath });
    }

    await fs.mkdir(dirPath, { recursive: true });
    return { content: [{ type: 'text', text: `Created ${dirPath}` }], structuredContent: { path: dirPath, created: true } };
  });

  server.registerTool('fs.write', {
    description: 'Write a file to disk.',
    inputSchema: { path: z.string(), content: z.string() }
  }, async ({ path: filePath, content }) => {
    const decision = await security.authorize('fs.write', { path: filePath, content: '[REDACTED]' });
    if (!decision.allowed) {
      return denyResult(decision.reason ?? 'Permission denied', { tool: 'fs.write', path: filePath });
    }

    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
    return { content: [{ type: 'text', text: `Wrote ${filePath}` }], structuredContent: { path: filePath, bytes: content.length } };
  });

  server.registerTool('fs.stat', {
    description: 'Get metadata for a file or directory.',
    inputSchema: { path: z.string() }
  }, async ({ path: filePath }) => {
    const decision = await security.authorize('fs.stat', { path: filePath });
    if (!decision.allowed) {
      return denyResult(decision.reason ?? 'Permission denied', { tool: 'fs.stat', path: filePath });
    }

    const meta = statSync(filePath);
    const payload = {
      path: filePath,
      size: meta.size,
      isFile: meta.isFile(),
      isDirectory: meta.isDirectory(),
      mtimeMs: meta.mtimeMs,
      birthtimeMs: meta.birthtimeMs
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
  });

  server.registerTool('fs.search', {
    description: 'Search a directory tree by filename or content.',
    inputSchema: {
      root: z.string(),
      query: z.string(),
      mode: z.enum(['name', 'content']).default('name')
    }
  }, async ({ root, query, mode }) => {
    const decision = await security.authorize('fs.search', { path: root, query });
    if (!decision.allowed) {
      return denyResult(decision.reason ?? 'Permission denied', { tool: 'fs.search', root, query, mode });
    }

    const results: string[] = [];
    const queue = [root];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (mode === 'name' && entry.name.includes(query)) {
          results.push(fullPath);
        }
        if (entry.isDirectory()) {
          queue.push(fullPath);
        }
        else if (mode === 'content') {
          try {
            const text = readFileSync(fullPath, 'utf8');
            if (text.includes(query)) {
              results.push(fullPath);
            }
          } catch {
            // ignore unreadable files
          }
        }
      }
    }

    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }], structuredContent: { results } };
  });

    // Connectors management for custom MCP connectors (Claude integration)
    server.registerTool('connectors.list', {
      description: 'List configured custom connectors (for Claude integrations).',
      inputSchema: {}
    }, async () => {
      const list = await connectors.list();
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }], structuredContent: { connectors: list } };
    });

    server.registerTool('connectors.add', {
      description: 'Add a custom connector (name + HTTPS URL).',
      inputSchema: { name: z.string(), url: z.string().describe('HTTPS endpoint for MCP e.g. https://mcp.example.com/mcp'), description: z.string().optional() }
    }, async ({ name, url, description }) => {
      const decision = await security.authorize('connectors.add', { name, url });
      if (!decision.allowed) {
        return denyResult(decision.reason ?? 'Permission denied', { tool: 'connectors.add', name, url });
      }
      const added = await connectors.add(name, url, description);
      audit.log({ timestamp: new Date().toISOString(), tool: 'connectors.add', decision: 'allow', result: JSON.stringify(added) });
      return { content: [{ type: 'text', text: JSON.stringify(added, null, 2) }], structuredContent: { connector: added } };
    });

    server.registerTool('connectors.remove', {
      description: 'Remove a configured connector by name.',
      inputSchema: { name: z.string() }
    }, async ({ name }) => {
      const decision = await security.authorize('connectors.remove', { name });
      if (!decision.allowed) {
        return denyResult(decision.reason ?? 'Permission denied', { tool: 'connectors.remove', name });
      }
      const ok = await connectors.remove(name);
      audit.log({ timestamp: new Date().toISOString(), tool: 'connectors.remove', decision: 'allow', result: JSON.stringify({ name, removed: ok }) });
      return { content: [{ type: 'text', text: JSON.stringify({ name, removed: ok }, null, 2) }], structuredContent: { name, removed: ok } };
    });

  server.registerTool('user.notify', {
    description: 'Send a desktop notification to the local user.',
    inputSchema: { title: z.string(), message: z.string() }
  }, async ({ title, message }) => {
    try {
      const strategy = process.platform === 'darwin' ? 'osascript' : process.platform === 'win32' ? 'powershell' : 'notify-send';
      if (process.platform === 'darwin') {
        await execAsync(`osascript -e 'display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"'`);
      } else if (process.platform === 'win32') {
        await execAsync(`powershell -NoProfile -Command "[System.Windows.Forms.MessageBox]::Show('${message.replace(/'/g, "''")}', '${title.replace(/'/g, "''")}', 0)"`);
      } else if (process.platform === 'linux') {
        await execAsync(`notify-send "${title.replace(/"/g, '\\"')}" "${message.replace(/"/g, '\\"')}"`);
      }
      return { content: [{ type: 'text', text: `Notification sent: ${title}` }], structuredContent: { title, message, strategy } };
    } catch (error) {
      return { content: [{ type: 'text', text: `Notification queued locally: ${title}` }], structuredContent: { title, message, strategy: 'fallback' } };
    }
  });

  server.registerTool('user.clipboard.read', {
    description: 'Read the system clipboard.',
    inputSchema: {}
  }, async () => {
    try {
      if (process.platform === 'darwin') {
        const { stdout } = await execAsync('pbpaste');
        return { content: [{ type: 'text', text: stdout }], structuredContent: { value: stdout } };
      }
      if (process.platform === 'linux') {
        const { stdout } = await execAsync('xclip -selection clipboard -o || xsel --clipboard --output || wl-paste');
        return { content: [{ type: 'text', text: stdout }], structuredContent: { value: stdout } };
      }
      const { stdout } = await execAsync('powershell -NoProfile -Command "Get-Clipboard"');
      return { content: [{ type: 'text', text: stdout }], structuredContent: { value: stdout } };
    } catch {
      return { content: [{ type: 'text', text: '' }], structuredContent: { value: '' } };
    }
  });

  server.registerTool('user.clipboard.write', {
    description: 'Write text to the system clipboard.',
    inputSchema: { value: z.string() }
  }, async ({ value }) => {
    try {
      if (process.platform === 'darwin') {
        await execAsync(`printf %s "${value.replace(/"/g, '\\"')}" | pbcopy`);
      } else if (process.platform === 'linux') {
        await execAsync(`printf %s "${value.replace(/"/g, '\\"')}" | xclip -selection clipboard || printf %s "${value.replace(/"/g, '\\"')}" | xsel --clipboard --input || printf %s "${value.replace(/"/g, '\\"')}" | wl-copy`);
      } else {
        await execAsync(`powershell -NoProfile -Command "Set-Clipboard -Value '${value.replace(/'/g, "''")}'"`);
      }
      return { content: [{ type: 'text', text: 'Clipboard updated' }], structuredContent: { ok: true } };
    } catch {
      return { content: [{ type: 'text', text: 'Clipboard unavailable' }], isError: true, structuredContent: { ok: false } };
    }
  });

  server.registerTool('user.open_url', {
    description: 'Open a URL in the default browser.',
    inputSchema: { url: z.string() }
  }, async ({ url }) => {
    try {
      if (process.platform === 'darwin') await execAsync(`open "${url}"`);
      else if (process.platform === 'win32') await execAsync(`cmd /c start "" "${url}"`);
      else await execAsync(`xdg-open "${url}"`);
      return { content: [{ type: 'text', text: `Opened ${url}` }], structuredContent: { url, ok: true } };
    } catch {
      return { content: [{ type: 'text', text: `Could not open ${url}` }], isError: true, structuredContent: { url, ok: false } };
    }
  });

  server.registerTool('user.input', {
    description: 'Prompt the user in the terminal and wait for input.',
    inputSchema: {
      message: z.string(),
      defaultValue: z.string().optional()
    }
  }, async ({ message, defaultValue }) => {
    const { createInterface } = await import('node:readline');
    const answer = await new Promise<string>((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`${message}${defaultValue ? ` [${defaultValue}]` : ''}: `, (value) => {
        rl.close();
        resolve(value || defaultValue || '');
      });
    });

    return { content: [{ type: 'text', text: answer }], structuredContent: { value: answer } };
  });

  server.registerTool('user.prompt', {
    description: 'Prompt the user in the terminal and wait for input.',
    inputSchema: {
      message: z.string(),
      defaultValue: z.string().optional()
    }
  }, async ({ message, defaultValue }) => {
    const { createInterface } = await import('node:readline');
    const answer = await new Promise<string>((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`${message}${defaultValue ? ` [${defaultValue}]` : ''}: `, (value) => {
        rl.close();
        resolve(value || defaultValue || '');
      });
    });

    return { content: [{ type: 'text', text: answer }], structuredContent: { value: answer } };
  });

  server.registerTool('user.confirm', {
    description: 'Prompt the user to confirm a dangerous or sensitive action.',
    inputSchema: {
      message: z.string(),
      defaultValue: z.boolean().optional()
    }
  }, async ({ message, defaultValue }) => {
    const prompt = defaultValue === true ? 'Y/n' : defaultValue === false ? 'y/N' : 'y/N';
    const { createInterface } = await import('node:readline');
    const answer = await new Promise<string>((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`${message} (${prompt}): `, (value) => {
        rl.close();
        resolve(value.trim().toLowerCase());
      });
    });

    const normalized = answer || (defaultValue ? 'y' : 'n');
    const confirmed = normalized === 'y' || normalized === 'yes' || normalized === 'true';
    return { content: [{ type: 'text', text: JSON.stringify({ confirmed }) }], structuredContent: { confirmed } };
  });

  server.registerTool('user.stdout.write', {
    description: 'Write a message to stdout.',
    inputSchema: { content: z.string() }
  }, async ({ content }) => {
    process.stdout.write(`${content}\n`);
    return { content: [{ type: 'text', text: `stdout: ${content}` }], structuredContent: { content } };
  });

  server.registerTool('user.stderr.write', {
    description: 'Write a message to stderr.',
    inputSchema: { content: z.string() }
  }, async ({ content }) => {
    process.stderr.write(`${content}\n`);
    return { content: [{ type: 'text', text: `stderr: ${content}` }], structuredContent: { content } };
  });

  // ---------------------------------------------------------------------------
  // Code execution, dependency installation and background processes
  // ---------------------------------------------------------------------------

  server.registerTool('runtime.detect', {
    description: 'Detect which language runtimes and package managers are installed (node, python, git, cargo, ...) and their versions. Call this before code.run or package.install.',
    inputSchema: {}
  }, async (_args, extra) => {
    const decision = await security.authorize('runtime.detect', {});
    if (!decision.allowed) {
      return denyResult(decision.reason ?? 'Permission denied', { tool: 'runtime.detect', sessionId: extra.sessionId });
    }

    const probes: Array<[string, string[]]> = [
      ['node', ['--version']], ['npm', ['--version']], ['pnpm', ['--version']], ['yarn', ['--version']], ['bun', ['--version']],
      ['tsx', ['--version']], ['python3', ['--version']], ['pip3', ['--version']], ['uv', ['--version']],
      ['git', ['--version']], ['go', ['version']], ['cargo', ['--version']], ['rustc', ['--version']],
      ['ruby', ['--version']], ['bash', ['--version']], ['docker', ['--version']]
    ];
    const entries = await Promise.all(probes.map(async ([file, args]) => {
      const location = findExecutable(file);
      if (!location) return [file, { installed: false }] as const;
      const result = await runProcess({ file, args, timeoutMs: 5000, maxOutputBytes: 4000 });
      const version = (result.stdout || result.stderr).split('\n')[0]?.trim();
      return [file, { installed: true, version, path: location }] as const;
    }));
    const runtimes = Object.fromEntries(entries);
    return {
      content: [textContent(JSON.stringify(runtimes, null, 2))],
      structuredContent: { runtimes }
    };
  });

  server.registerTool('code.run', {
    description: 'Run a code snippet (python, javascript, typescript, bash, sh, ruby, go) and return stdout, stderr and the exit code. The code is written to a temp file and executed directly; use cwd to run it inside a project. Subject to approval.',
    inputSchema: {
      language: z.enum(SUPPORTED_LANGUAGES).describe('Language of the snippet'),
      code: z.string().min(1).max(200_000).describe('Source code to run'),
      args: z.array(z.string()).max(50).optional().describe('Command-line arguments passed to the script'),
      stdin: z.string().max(1_000_000).optional().describe('Text piped to the script on stdin'),
      cwd: z.string().optional().describe('Working directory (defaults to a fresh temp directory)'),
      timeoutMs: z.number().int().positive().optional().describe('Timeout in ms (default 30000, max 600000)')
    }
  }, async ({ language, code, args, stdin, cwd, timeoutMs }, extra) => {
    const sessionId = extra.sessionId ?? createSessionId();
    const resolved = resolveLanguage(language);
    if (!resolved) {
      const message = `No interpreter for '${language}' was found on PATH. Run runtime.detect to see what is installed.`;
      return { content: [textContent(message)], isError: true, structuredContent: { error: message } };
    }

    const decision = await security.authorize('code.run', {
      command: resolved.file,
      cwd,
      language,
      code,
      args,
      fingerprint: fingerprintOf(language, code, JSON.stringify(args ?? []), stdin ?? '', cwd ?? '')
    });
    if (!decision.allowed) {
      audit.log({ timestamp: new Date().toISOString(), sessionId, tool: 'code.run', decision: 'deny', result: decision.reason ?? 'Denied' });
      return denyResult(decision.reason ?? 'Permission denied', { tool: 'code.run', sessionId, language, cwd });
    }

    const result = await runCode({ resolved, code, args, stdin, cwd, timeoutMs });
    audit.log({ timestamp: new Date().toISOString(), sessionId, tool: 'code.run', decision: 'allow', result: `${language} exit=${result.exitCode} ${result.timedOut ? 'timeout ' : ''}${truncateForLog(result.stdout || result.stderr)}` });
    return runResultToToolResult(result, { language, interpreter: resolved.file });
  });

  server.registerTool('package.install', {
    description: 'Install dependencies with npm, pnpm, yarn, bun, pip, uv, cargo or go. Pass packages to add them, or omit packages to install from the project manifest (package.json, requirements.txt via requirementsFile, pyproject.toml, Cargo.toml, go.mod). Runs without a shell. Subject to approval.',
    inputSchema: {
      manager: z.enum(PACKAGE_MANAGERS).describe('Package manager to use'),
      packages: z.array(z.string()).max(50).optional().describe("Packages to install, e.g. ['express', 'zod@3']"),
      cwd: z.string().optional().describe('Project directory (defaults to the server working directory)'),
      dev: z.boolean().optional().describe('Install as a dev dependency where supported'),
      global: z.boolean().optional().describe('Install globally (npm, pnpm, yarn, bun, cargo, go)'),
      ignoreScripts: z.boolean().optional().describe('Skip package lifecycle scripts (npm, pnpm, yarn, bun)'),
      venv: z.string().optional().describe('pip only: virtualenv directory to install into (created if missing)'),
      requirementsFile: z.string().optional().describe('pip only: install from this requirements file'),
      timeoutMs: z.number().int().positive().optional().describe('Timeout in ms (default 300000, max 600000)')
    }
  }, async ({ manager, packages, cwd, dev, global, ignoreScripts, venv, requirementsFile, timeoutMs }, extra) => {
    const sessionId = extra.sessionId ?? createSessionId();
    const python = findExecutable('python3') ? 'python3' : findExecutable('python') ? 'python' : undefined;
    const venvDir = venv ? path.resolve(cwd ?? process.cwd(), venv) : undefined;
    const plan = buildInstallPlan(
      { manager, packages, dev, global, ignoreScripts, venv: venvDir, requirementsFile },
      { venvExists: venvDir ? existsSync(venvDir) : false, python }
    );
    if (!plan.ok) {
      return { content: [textContent(plan.error)], isError: true, structuredContent: { error: plan.error } };
    }

    const decision = await security.authorize('package.install', {
      command: manager,
      cwd,
      manager,
      packages: packages ?? [],
      global: Boolean(global),
      plan: plan.display,
      fingerprint: fingerprintOf(plan.display, cwd ?? '')
    });
    if (!decision.allowed) {
      audit.log({ timestamp: new Date().toISOString(), sessionId, tool: 'package.install', decision: 'deny', result: decision.reason ?? 'Denied' });
      return denyResult(decision.reason ?? 'Permission denied', { tool: 'package.install', sessionId, manager, packages, cwd });
    }

    const stepResults: Array<{ command: string; exitCode: number | null; timedOut: boolean; durationMs: number }> = [];
    let output = '';
    let failed = false;
    for (const step of plan.steps) {
      const label = [step.file, ...step.args].join(' ');
      if (!step.file.includes(path.sep) && !findExecutable(step.file)) {
        output += `$ ${label}\n'${step.file}' was not found on PATH.\n`;
        stepResults.push({ command: label, exitCode: null, timedOut: false, durationMs: 0 });
        failed = true;
        break;
      }
      const result = await runProcess({ file: step.file, args: step.args, cwd, timeoutMs: clampTimeout(timeoutMs, 300_000) });
      output += `$ ${label}\n${result.stdout}${result.stderr}${result.spawnError ? `${result.spawnError}\n` : ''}`;
      stepResults.push({ command: label, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs });
      if (result.exitCode !== 0 || result.timedOut || result.spawnError) {
        failed = true;
        break;
      }
    }

    audit.log({ timestamp: new Date().toISOString(), sessionId, tool: 'package.install', decision: 'allow', result: `${plan.display} ${failed ? 'FAILED' : 'ok'}` });
    return {
      content: [textContent(output)],
      ...(failed ? { isError: true } : {}),
      structuredContent: { ok: !failed, steps: stepResults }
    };
  });

  server.registerTool('process.start', {
    description: 'Start a long-running command in the background (dev server, watcher, training job) and return an id. Use process.logs to read its output and process.stop to end it. Subject to approval.',
    inputSchema: {
      command: z.string().min(1).describe('Command to run (executed through the shell)'),
      cwd: z.string().optional().describe('Working directory'),
      name: z.string().max(80).optional().describe('Optional label'),
      waitMs: z.number().int().min(0).max(10_000).optional().describe('Wait this long (default 1000) and return early output / startup failures')
    }
  }, async ({ command, cwd, name, waitMs }, extra) => {
    const sessionId = extra.sessionId ?? createSessionId();
    const decision = await security.authorize('process.start', {
      command,
      cwd,
      fingerprint: fingerprintOf(command, cwd ?? '')
    });
    if (!decision.allowed) {
      audit.log({ timestamp: new Date().toISOString(), sessionId, tool: 'process.start', decision: 'deny', result: decision.reason ?? 'Denied' });
      return denyResult(decision.reason ?? 'Permission denied', { tool: 'process.start', sessionId, command, cwd });
    }

    try {
      const entry = processes.start(command, { cwd, name });
      await new Promise((resolve) => setTimeout(resolve, waitMs ?? 1000));
      audit.log({ timestamp: new Date().toISOString(), sessionId, tool: 'process.start', decision: 'allow', result: `${entry.id} pid=${entry.pid} ${truncateForLog(command)}` });
      const payload = { ...summarizeProcess(entry), initialOutput: processes.logs(entry.id, 4000) ?? '' };
      return { content: [textContent(JSON.stringify(payload, null, 2))], structuredContent: payload };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [textContent(message)], isError: true, structuredContent: { error: message } };
    }
  });

  server.registerTool('process.list', {
    description: 'List background processes started with process.start, with their status and exit codes.',
    inputSchema: {}
  }, async () => {
    const decision = await security.authorize('process.list', {});
    if (!decision.allowed) return denyResult(decision.reason ?? 'Permission denied', { tool: 'process.list' });
    const list = processes.list().map(summarizeProcess);
    return { content: [textContent(JSON.stringify(list, null, 2))], structuredContent: { processes: list } };
  });

  server.registerTool('process.logs', {
    description: 'Read the most recent output (stdout and stderr combined) of a background process.',
    inputSchema: {
      id: z.string().describe('Process id from process.start'),
      tailChars: z.number().int().positive().max(100_000).optional().describe('How many trailing characters to return (default 8000)')
    }
  }, async ({ id, tailChars }) => {
    const decision = await security.authorize('process.logs', {});
    if (!decision.allowed) return denyResult(decision.reason ?? 'Permission denied', { tool: 'process.logs' });
    const entry = processes.get(id);
    if (!entry) {
      const message = `Unknown process id: ${id}`;
      return { content: [textContent(message)], isError: true, structuredContent: { error: message } };
    }
    const logs = processes.logs(id, tailChars ?? 8000) ?? '';
    return {
      content: [textContent(logs || '(no output yet)')],
      structuredContent: { ...summarizeProcess(entry), logs }
    };
  });

  server.registerTool('process.stop', {
    description: 'Stop a background process (and its child processes) started with process.start.',
    inputSchema: { id: z.string().describe('Process id from process.start') }
  }, async ({ id }, extra) => {
    const sessionId = extra.sessionId ?? createSessionId();
    const decision = await security.authorize('process.stop', {});
    if (!decision.allowed) return denyResult(decision.reason ?? 'Permission denied', { tool: 'process.stop' });
    const entry = await processes.stop(id);
    if (!entry) {
      const message = `Unknown process id: ${id}`;
      return { content: [textContent(message)], isError: true, structuredContent: { error: message } };
    }
    audit.log({ timestamp: new Date().toISOString(), sessionId, tool: 'process.stop', decision: 'allow', result: `${id} -> ${entry.status}` });
    const payload = summarizeProcess(entry);
    return { content: [textContent(JSON.stringify(payload, null, 2))], structuredContent: payload };
  });

  server.registerResource('system://info', 'system://info', { mimeType: 'application/json' }, async () => ({
    contents: [{ uri: 'system://info', mimeType: 'application/json', text: JSON.stringify({ platform: process.platform, cwd: process.cwd(), user: process.env.USER || process.env.USERNAME || 'unknown' }) }]
  }));

  server.registerResource('fs://cwd', 'fs://cwd', { mimeType: 'application/json' }, async () => ({
    contents: [{ uri: 'fs://cwd', mimeType: 'application/json', text: JSON.stringify({ cwd: process.cwd() }) }]
  }));

  return server;
}

export async function createSseHttpServer(config: AppConfig = defaultConfig): Promise<{ app: express.Express; server: any }> {
  installExitCleanup();
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  // Keyed by the MCP session id (the `Mcp-Session-Id` header), one live
  // McpServer + transport pair per connected client (e.g. per Claude custom connector session).
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  const requireAuth = authMiddleware(config);

  app.get('/health', (_req: any, res: any) => {
    res.json({ ok: true, transport: 'http', port: config.port });
  });

  // Claude Connector validation probe / OAuth discovery check:
  // some clients send a plain GET (Accept: application/json) before ever
  // speaking MCP, just to sanity-check the endpoint. Answer that here, and
  // treat anything that accepts text/event-stream as a real transport request.
  async function handleStreamableRequest(req: any, res: any) {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport = sessionId ? transports[sessionId] : undefined;

    if (!transport) {
      // A brand-new session is only allowed to start with an initialize call.
      if (req.method === 'POST' && !sessionId && req.body && req.body.method === 'initialize') {
        const server = createLocalMcpServer(config);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            transports[newSessionId] = transport as StreamableHTTPServerTransport;
          }
        });

        transport.onclose = () => {
          const sid = transport?.sessionId;
          if (sid) delete transports[sid];
        };

        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: missing or invalid Mcp-Session-Id. Send an initialize request first.' },
          id: req.body?.id ?? null
        });
        return;
      }
    }

    await transport.handleRequest(req, res, req.body);
  }

  app.get('/mcp', requireAuth, async (req: any, res: any) => {
    const accept = req.headers['accept'] || '';
    if (!accept.includes('text/event-stream') && !req.headers['mcp-session-id']) {
      res.json({
        name: 'local-mcp',
        version: '0.1.0',
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        authentication: { required: config.auth.requireAuth }
      });
      return;
    }
    await handleStreamableRequest(req, res);
  });

  app.post('/mcp', requireAuth, async (req: any, res: any) => {
    await handleStreamableRequest(req, res);
  });

  app.delete('/mcp', requireAuth, async (req: any, res: any) => {
    await handleStreamableRequest(req, res);
  });

  const instance = app.listen(config.port, () => {
    console.log(`Local-MCP Streamable HTTP server listening on port ${config.port}`);
  });

  return { app, server: instance };
}

export async function startLocalMcpTransport(config: AppConfig = defaultConfig): Promise<void> {
  if (config.transport === 'sse') {
    await createSseHttpServer(config);
    return;
  }

  installExitCleanup();
  const server = createLocalMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
