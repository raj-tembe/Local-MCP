import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createSseHttpServer } from './server.js';
import { loadConfig } from '../config/config.js';

const defaultOAuth = { enabled: false, clientId: '', clientSecret: '', issuerUrl: '', audience: '' };

describe('SSE server authentication', () => {
  let server: any;
  let app: express.Express;

  beforeAll(async () => {
    const config = loadConfig({
      transport: 'sse',
      auth: { requireAuth: true, apiKeys: ['valid-key-1', 'valid-key-2'], oauth: defaultOAuth }
    });
    const result = await createSseHttpServer(config);
    app = result.app;
    server = result.server;
    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  afterAll(() => {
    server.close();
  });

  it('allows requests without auth when requireAuth is false', async () => {
    const config = loadConfig({
      transport: 'sse',
      auth: { requireAuth: false, apiKeys: ['test-key'], oauth: defaultOAuth }
    });
    const { app: app2, server: server2 } = await createSseHttpServer(config);

    const response = await request(app2).get('/mcp').set('Accept', 'application/json');
    expect(response.status).toBe(200);
    expect(response.body.authentication.required).toBe(false);

    server2.close();
  });

  it('allows requests with valid API key when requireAuth is true', async () => {
    const response = await request(app)
      .get('/mcp')
      .set('Accept', 'application/json')
      .set('Authorization', 'Bearer valid-key-1');
    expect(response.status).toBe(200);
    expect(response.body.authentication.required).toBe(true);
  });

  it('rejects requests without API key when requireAuth is true', async () => {
    const response = await request(app)
      .get('/mcp')
      .set('Accept', 'application/json');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe(-32600);
  });

  it('rejects requests with invalid API key when requireAuth is true', async () => {
    const response = await request(app)
      .get('/mcp')
      .set('Accept', 'application/json')
      .set('Authorization', 'Bearer invalid-key');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe(-32600);
  });

  it('accepts API key without Bearer prefix', async () => {
    const response = await request(app)
      .get('/mcp')
      .set('Accept', 'application/json')
      .set('Authorization', 'valid-key-1');
    expect(response.status).toBe(200);
  });

  it('returns auth required=true in metadata when requireAuth is true', async () => {
    const response = await request(app)
      .get('/mcp')
      .set('Accept', 'application/json')
      .set('Authorization', 'Bearer valid-key-1');
    expect(response.status).toBe(200);
    expect(response.body.authentication.required).toBe(true);
  });

  it('returns auth required=false in metadata when requireAuth is false', async () => {
    const config = loadConfig({
      transport: 'sse',
      auth: { requireAuth: false, apiKeys: ['valid-key'], oauth: defaultOAuth }
    });
    const { app: app2, server: server2 } = await createSseHttpServer(config);

    const response = await request(app2)
      .get('/mcp')
      .set('Accept', 'application/json');
    expect(response.status).toBe(200);
    expect(response.body.authentication.required).toBe(false);

    server2.close();
  });

  it('health endpoint is always accessible without auth', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });
});