import { loadConfig, type AppConfig } from './config.js';

export type StartOptions = { transport?: string; port?: string };

/**
 * Config for `local-mcp start`. Only values given on the command line are passed as overrides:
 * overrides win over the config file and environment variables, so passing defaults here would
 * silently discard both.
 */
export function buildStartConfig(options: StartOptions): AppConfig {
  return loadConfig({
    ...(options.transport ? { transport: options.transport as AppConfig['transport'] } : {}),
    ...(options.port ? { port: Number.parseInt(options.port, 10) } : {})
  });
}
