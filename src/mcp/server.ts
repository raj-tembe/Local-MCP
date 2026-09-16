import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import express from 'express';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { statSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type AppConfig, defaultConfig } from '../config/config.js';
import { SecurityEngine, createSessionId } from '../security/security.js';
import { AuditLogger } from '../audit/audit.js';
import { TerminalManager } from '../terminal/manager.js';
import ConnectorsStore from '../connectors/store.js';

const execAsync = promisify(exec);

const textContent = (text: string) => ({ type: 'text' as const, text });

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

  server.registerResource('system://info', 'system://info', { mimeType: 'application/json' }, async () => ({
    contents: [{ uri: 'system://info', mimeType: 'application/json', text: JSON.stringify({ platform: process.platform, cwd: process.cwd(), user: process.env.USER || process.env.USERNAME || 'unknown' }) }]
  }));

  server.registerResource('fs://cwd', 'fs://cwd', { mimeType: 'application/json' }, async () => ({
    contents: [{ uri: 'fs://cwd', mimeType: 'application/json', text: JSON.stringify({ cwd: process.cwd() }) }]
  }));

  return server;
}

export async function createSseHttpServer(config: AppConfig = defaultConfig): Promise<{ app: ReturnType<typeof createMcpExpressApp>; server: any }> {
  const app = createMcpExpressApp({ host: '0.0.0.0' });
  app.use(express.json({ limit: '4mb' }));
  const transports: Record<string, any> = {};

  app.get('/health', (_req: any, res: any) => {
    res.json({ ok: true, transport: 'sse', port: config.port });
  });

  app.get('/mcp', async (req: any, res: any) => {
    const transport = new SSEServerTransport('/messages', res);
    const sessionId = transport.sessionId;
    transports[sessionId] = transport;
    transport.onclose = () => delete transports[sessionId];
    const server = createLocalMcpServer(config);
    await server.connect(transport);
  });

  app.post('/messages', async (req: any, res: any) => {
    const sessionId = (req.query.sessionId as string | undefined) ?? (req.body && req.body.sessionId ? String(req.body.sessionId) : undefined);
    const transport = sessionId ? transports[sessionId] : undefined;
    if (!transport) {
      res.status(404).json({ ok: false, reason: 'Session not found' });
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });

  const instance = app.listen(config.port, () => {
    console.log(`Local-MCP SSE server listening on port ${config.port}`);
  });

  return { app, server: instance };
}

export async function startLocalMcpTransport(config: AppConfig = defaultConfig): Promise<void> {
  if (config.transport === 'sse') {
    await createSseHttpServer(config);
    return;
  }

  const server = createLocalMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
