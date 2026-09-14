#!/usr/bin/env node
import { Command } from 'commander';
import { defaultConfig, loadConfig, writeDefaultConfig } from './config/config.js';
import { startLocalMcpTransport } from './mcp/server.js';

const program = new Command();
program.name('local-mcp').description('Secure local terminal bridge for cloud-based AI via MCP.');

program
  .command('init')
  .description('Create a safe default config file')
  .option('--path <path>', 'Destination config path')
  .action((options) => {
    const outputPath = writeDefaultConfig(options.path ?? '~/.local-mcp/config.json');
    console.log(`Created config at ${outputPath}`);
  });

program
  .command('start')
  .description('Start the MCP server')
  .option('--transport <transport>', 'Transport to run: stdio, sse, http', 'stdio')
  .option('--port <port>', 'Port for SSE/HTTP transport')
  .action(async (options) => {
    const cfg = loadConfig({
      ...defaultConfig,
      transport: options.transport,
      ...(options.port ? { port: Number.parseInt(options.port, 10) } : {})
    });
    console.log(`Starting Local-MCP with ${cfg.transport} transport on port ${cfg.port}`);
    await startLocalMcpTransport(cfg);
  });

program
  .command('config')
  .description('Configuration utilities')
  .command('list')
  .description('List current configuration')
  .action(() => {
    console.log(JSON.stringify(loadConfig(), null, 2));
  });

program
  .command('doctor')
  .description('Check environment and configuration health')
  .action(() => {
    const cfg = loadConfig();
    console.log(JSON.stringify({
      node: process.version,
      platform: process.platform,
      cwd: process.cwd(),
      transport: cfg.transport,
      security: cfg.security.defaultMode
    }, null, 2));
  });

program.parse(process.argv);
