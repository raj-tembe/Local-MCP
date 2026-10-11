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
const PROTOCOLS = ['auto', 'quic', 'http2'];

// Transport used between cloudflared and Cloudflare's edge. QUIC (UDP) is cloudflared's
// default, but some networks drop UDP intermittently, which shows up as repeated
// "failed to dial to edge with quic ... no recent network activity" errors and requests
// that hang. `http2` (TCP) is slightly slower to connect but much more reliable there.
//   CLOUDFLARED_PROTOCOL=http2 node run-cloudflared.js
//   node run-cloudflared.js --protocol http2
function resolveProtocol() {
  const flag = process.argv.find((arg) => arg === '--protocol' || arg.startsWith('--protocol='));
  let value;
  if (flag === '--protocol') value = process.argv[process.argv.indexOf(flag) + 1];
  else if (flag) value = flag.slice('--protocol='.length);
  value = value ?? process.env.CLOUDFLARED_PROTOCOL;
  if (!value) return undefined;
  if (!PROTOCOLS.includes(value)) {
    console.error(`Invalid protocol '${value}'. Use one of: ${PROTOCOLS.join(', ')}`);
    process.exit(1);
  }
  return value;
}

function main() {
  const protocol = resolveProtocol();
  const args = ['tunnel', '--url', `http://localhost:${port}`];
  if (protocol) args.push('--protocol', protocol);

  console.log(`Starting Cloudflare Quick Tunnel to http://localhost:${port}${protocol ? ` (protocol: ${protocol})` : ''} ... (press Ctrl+C to stop)`);

  const child = spawn('cloudflared', args, {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let printed = false;
  let quicFailures = 0;
  let hinted = false;
  const onData = (chunk) => {
    const text = chunk.toString();
    process.stderr.write(text); // mirror cloudflared's own logs for visibility

    if (!hinted && protocol !== 'http2') {
      quicFailures += (text.match(/Failed to dial a quic connection|no recent network activity/g) ?? []).length;
      if (quicFailures >= 3) {
        hinted = true;
        console.log('\nTip: the QUIC (UDP) connection to Cloudflare keeps timing out on this network.');
        console.log('Restart with TCP instead:  node examples/expose-cloudflared/run-cloudflared.js --protocol http2');
        console.log('(the tunnel URL changes on restart, so update the connector in Claude)\n');
      }
    }
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
