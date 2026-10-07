#!/usr/bin/env node
// Starts a Cloudflare Quick Tunnel (cloudflared) pointed at a local Local-MCP
// instance and prints the public https://*.trycloudflare.com URL once the
// tunnel is up. No Cloudflare account, no paid plan, and unlike ngrok's free
// tier it does not inject a browser-warning interstitial page in front of
// requests, so Claude's connector can talk to it directly.
//
// Requires the `cloudflared` binary on PATH:
//   macOS:   brew install cloudflared
//   Linux:   https://pkg.cloudflare.com/ (apt/yum) or download a release binary
//   Windows: winget install --id Cloudflare.cloudflared

import { spawn } from 'node:child_process';

const port = Number(process.env.PORT || 8080);
const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

function main() {
  console.log(`Starting Cloudflare Quick Tunnel to http://localhost:${port} ... (press Ctrl+C to stop)`);

  const child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let printed = false;
  const onData = (chunk) => {
    const text = chunk.toString();
    process.stderr.write(text); // mirror cloudflared's own logs for visibility
    if (!printed) {
      const match = text.match(URL_PATTERN);
      if (match) {
        printed = true;
        console.log('\nCloudflare public URL:', match[0]);
        console.log(`MCP connector URL:     ${match[0]}/mcp`);
        console.log('\nPaste the MCP connector URL into Claude: Settings -> Connectors -> Add custom connector.');
      }
    }
  };

  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('error', (err) => {
    console.error('\nFailed to start cloudflared. Is it installed and on your PATH?');
    console.error(err.message);
    process.exit(1);
  });

  child.on('exit', (code) => {
    if (!printed && code !== 0) {
      console.error(`\ncloudflared exited before a tunnel URL was found (exit code ${code}).`);
    }
    process.exit(code ?? 0);
  });

  const shutdown = () => {
    console.log('\nStopping Cloudflare tunnel...');
    child.kill('SIGINT');
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
