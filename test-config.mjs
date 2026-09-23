import { loadConfig } from './dist/config/config.js';

const config = loadConfig({ transport: 'sse', port: 8080 });
console.log('auth:', JSON.stringify(config.auth, null, 2));
console.log('requireAuth:', config.auth.requireAuth);
console.log('apiKeys:', config.auth.apiKeys);
