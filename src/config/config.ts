import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export const securityConfigSchema = z.object({
  defaultMode: z.enum(['ask', 'allow', 'deny']).default('ask'),
  allowedCommands: z.array(z.string()).default(['ls', 'cat', 'git', 'npm', 'node', 'echo']),
  deniedCommands: z.array(z.string()).default(['rm', 'sudo', 'dd', 'mkfs', 'shutdown', 'reboot']),
  allowedPaths: z.array(z.string()).default(['~', '/tmp', '/var/tmp']),
  deniedPaths: z.array(z.string()).default(['/etc', '/root', '~/.ssh', '/proc', '/sys']),
  requireApproval: z.array(z.string()).default(['fs.write', 'shell.execute']),
  maxCommandLength: z.number().default(4096),
  sessionTimeoutMs: z.number().default(300000),
  rateLimitPerMinute: z.number().default(60)
});

export const loggingConfigSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  auditFile: z.string().default('~/.local-mcp/audit.jsonl')
});

export const authConfigSchema = z.object({
  apiKeys: z.array(z.string()).default([]),
  requireAuth: z.boolean().default(false),
  oauth: z.object({
    enabled: z.boolean().default(false),
    clientId: z.string().default(''),
    clientSecret: z.string().default(''),
    issuerUrl: z.string().default(''),
    audience: z.string().default('')
  }).default({ enabled: false, clientId: '', clientSecret: '', issuerUrl: '', audience: '' })
});

export const toolFilterConfigSchema = z.object({
  allowedTools: z.array(z.string()).default([]),
  deniedTools: z.array(z.string()).default(['shell.execute', 'terminal.write', 'fs.write', 'fs.mkdir', 'user.clipboard.write'])
});

export const cloudConfigSchema = z.object({
  relayUrl: z.string().default(''),
  token: z.string().default('')
});

export const appConfigSchema = z.object({
  transport: z.enum(['stdio', 'sse', 'http']).default('stdio'),
  port: z.number().default(3000),
  security: securityConfigSchema.default({}),
  logging: loggingConfigSchema.default({}),
  cloud: cloudConfigSchema.default({}),
  auth: authConfigSchema.default({}),
  toolFilter: toolFilterConfigSchema.default({})
});

export type SecurityConfig = z.infer<typeof securityConfigSchema>;
export type LoggingConfig = z.infer<typeof loggingConfigSchema>;
export type CloudConfig = z.infer<typeof cloudConfigSchema>;
export type AuthConfig = z.infer<typeof authConfigSchema>;
export type ToolFilterConfig = z.infer<typeof toolFilterConfigSchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;

export const defaultConfig: AppConfig = {
  transport: 'stdio',
  port: 3000,
  security: {
    defaultMode: 'ask',
    allowedCommands: ['ls', 'cat', 'git', 'npm', 'node', 'echo'],
    deniedCommands: ['rm', 'sudo', 'dd', 'mkfs', 'shutdown', 'reboot'],
    allowedPaths: ['~', '/tmp', '/var/tmp'],
    deniedPaths: ['/etc', '/root', '~/.ssh', '/proc', '/sys'],
    requireApproval: ['fs.write', 'shell.execute'],
    maxCommandLength: 4096,
    sessionTimeoutMs: 300000,
    rateLimitPerMinute: 60
  },
  logging: {
    level: 'info',
    auditFile: '~/.local-mcp/audit.jsonl'
  },
  cloud: {
    relayUrl: '',
    token: ''
  },
  auth: {
    apiKeys: [],
    requireAuth: false,
    oauth: {
      enabled: false,
      clientId: '',
      clientSecret: '',
      issuerUrl: '',
      audience: ''
    }
  },
  toolFilter: {
    allowedTools: [],
    deniedTools: ['shell.execute', 'terminal.write', 'fs.write', 'fs.mkdir', 'user.clipboard.write']
  }
};

export function resolveConfigPath(value: string): string {
  if (!value) {
    return value;
  }

  if (value.startsWith('~')) {
    return path.join(os.homedir(), value.slice(1));
  }

  return path.resolve(value);
}

export function readJsonFile(filePath: string): Record<string, unknown> | undefined {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

export function mergeConfig(base: AppConfig, incoming: Partial<AppConfig> = {}): AppConfig {
  return {
    ...base,
    ...incoming,
    security: {
      ...base.security,
      ...(incoming.security ?? {})
    },
    logging: {
      ...base.logging,
      ...(incoming.logging ?? {})
    },
    cloud: {
      ...base.cloud,
      ...(incoming.cloud ?? {})
    },
    auth: {
      ...base.auth,
      ...(incoming.auth ?? {}),
      oauth: {
        ...base.auth.oauth,
        ...(incoming.auth?.oauth ?? {})
      }
    },
    toolFilter: {
      ...base.toolFilter,
      ...(incoming.toolFilter ?? {})
    }
  };
}

export function envOverrides(): Partial<AppConfig> {
  const config: Partial<AppConfig> = {};

  const transport = process.env.LOCAL_MCP_TRANSPORT;
  if (transport && (transport === 'stdio' || transport === 'sse' || transport === 'http')) {
    config.transport = transport;
  }

  const port = process.env.LOCAL_MCP_PORT;
  if (port) {
    const parsed = Number.parseInt(port, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      config.port = parsed;
    }
  }

  const defaultMode = process.env.LOCAL_MCP_DEFAULT_MODE;
  if (defaultMode && ['ask', 'allow', 'deny'].includes(defaultMode)) {
    config.security = {
      ...(config.security ?? defaultConfig.security),
      defaultMode: defaultMode as 'ask' | 'allow' | 'deny'
    };
  }

  const auditFile = process.env.LOCAL_MCP_AUDIT_FILE;
  if (auditFile) {
    config.logging = {
      ...(config.logging ?? defaultConfig.logging),
      auditFile
    };
  }

  const relayUrl = process.env.LOCAL_MCP_RELAY_URL;
  const token = process.env.LOCAL_MCP_TOKEN;
  if (relayUrl || token) {
    config.cloud = {
      ...(config.cloud ?? defaultConfig.cloud),
      relayUrl: relayUrl ?? '',
      token: token ?? ''
    };
  }

  const apiKeys = process.env.LOCAL_MCP_API_KEYS;
  if (apiKeys) {
    config.auth = {
      ...(config.auth ?? defaultConfig.auth),
      apiKeys: apiKeys.split(',').map(k => k.trim()).filter(k => k),
      requireAuth: true
    };
  }

  const requireAuth = process.env.LOCAL_MCP_REQUIRE_AUTH;
  if (requireAuth && ['true', 'false'].includes(requireAuth.toLowerCase())) {
    config.auth = {
      ...(config.auth ?? defaultConfig.auth),
      requireAuth: requireAuth.toLowerCase() === 'true'
    };
  }

  const allowedTools = process.env.LOCAL_MCP_ALLOWED_TOOLS;
  if (allowedTools) {
    config.toolFilter = {
      ...(config.toolFilter ?? defaultConfig.toolFilter),
      allowedTools: allowedTools.split(',').map(t => t.trim()).filter(t => t)
    };
  }

  const deniedTools = process.env.LOCAL_MCP_DENIED_TOOLS;
  if (deniedTools) {
    config.toolFilter = {
      ...(config.toolFilter ?? defaultConfig.toolFilter),
      deniedTools: deniedTools.split(',').map(t => t.trim()).filter(t => t)
    };
  }

  return config;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const configCandidates = [
    path.join(process.cwd(), 'local-mcp.config.json'),
    path.join(process.cwd(), '.local-mcp', 'config.json'),
    path.join(os.homedir(), '.local-mcp', 'config.json')
  ];

  let merged: AppConfig = { ...defaultConfig };
  for (const filePath of configCandidates) {
    const raw = readJsonFile(filePath);
    if (!raw) {
      continue;
    }

    const parsed = appConfigSchema.safeParse(raw);
    if (parsed.success) {
      merged = mergeConfig(merged, parsed.data);
    }
  }

  merged = mergeConfig(merged, envOverrides());
  merged = mergeConfig(merged, overrides);

  return appConfigSchema.parse(merged);
}

export function writeDefaultConfig(filePath = path.join(os.homedir(), '.local-mcp', 'config.json')): string {
  const resolved = resolveConfigPath(filePath);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(defaultConfig, null, 2) + '\n', 'utf8');
  return resolved;
}
