#!/usr/bin/env node
import { Command } from 'commander';
import { defaultConfig, loadConfig, writeDefaultConfig } from './config/config.js';
import { startLocalMcpTransport } from './mcp/server.js';
import ApprovalStore from './security/store.js';
import ConnectorsStore from './connectors/store.js';

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

program
  .command('approvals')
  .description('Manage persisted approval decisions')
  .command('list')
  .description('List persisted approvals')
  .action(async () => {
    const store = new ApprovalStore();
    const list = await store.list();
    console.log(JSON.stringify(list, null, 2));
  });

program
  .command('approvals:clear')
  .description('Clear persisted approvals')
  .action(async () => {
    const store = new ApprovalStore();
    await store.clear();
    console.log('Cleared approvals');
  });

program
  .command('connectors')
  .description('Manage custom connectors')
  .command('list')
  .description('List configured connectors')
  .action(async () => {
    const store = new ConnectorsStore();
    const all = await store.list();
    console.log(JSON.stringify(all, null, 2));
  });

program
  .command('connectors:add')
  .description('Add a connector: name url [description]')
  .argument('<name>')
  .argument('<url>')
  .argument('[description]')
  .action(async (name, url, description) => {
    const store = new ConnectorsStore();
    const added = await store.add(name, url, description);
    console.log(JSON.stringify(added, null, 2));
  });

program
  .command('connectors:remove')
  .description('Remove a connector by name')
  .argument('<name>')
  .action(async (name) => {
    const store = new ConnectorsStore();
    const ok = await store.remove(name);
    console.log(ok ? 'Removed' : 'Not found');
  });

program.parse(process.argv);
