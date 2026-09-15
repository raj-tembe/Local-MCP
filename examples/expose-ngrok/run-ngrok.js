#!/usr/bin/env node
import ngrok from '@ngrok/ngrok';

async function main() {
  const port = Number(process.env.PORT || 8080);
  try {
    console.log(`Starting ngrok tunnel to localhost:${port}... (press Ctrl+C to stop)`);
    const url = await ngrok.connect({ addr: port });
    console.log(`ngrok public URL: ${url}`);
    console.log('ngrok web UI: http://127.0.0.1:4040');
    // keep running until interrupted
    process.on('SIGINT', async () => {
      console.log('Disconnecting ngrok...');
      await ngrok.disconnect();
      await ngrok.kill();
      process.exit(0);
    });
    // prevent exit
    await new Promise(() => {});
  } catch (err) {
    console.error('Failed to start ngrok:', err);
    process.exit(1);
  }
}

main();
