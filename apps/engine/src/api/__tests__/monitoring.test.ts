import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { apiRoutes } from '../routes.js';
import { authenticateApiKey } from '../auth.js';

describe('API Monitoring & Health Probes Suite (HEAD & GET)', () => {
  let app: FastifyInstance;
  let mockRedisPingResponse = 'PONG';
  let mockHealthTrackerDegraded = false;

  beforeAll(async () => {
    process.env.ENGINE_API_KEY = 'test_secret_key';

    app = fastify({ logger: false });

    await app.register(cors, {
      origin: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'idempotency-key', 'x-business-id'],
      exposedHeaders: ['x-service-status', 'x-service-name', 'x-service-version', 'x-uptime-seconds'],
    });

    app.addHook('preHandler', authenticateApiKey);

    const mockDeps = {
      orchestrator: {} as any,
      paymentRepo: {} as any,
      healthTracker: {
        isDegraded: () => mockHealthTrackerDegraded,
      } as any,
      redis: {
        ping: async () => mockRedisPingResponse,
      } as any,
    };

    await app.register(apiRoutes(mockDeps));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('HEAD / (Root heartbeat probe)', () => {
    it('returns HTTP 200 with monitoring headers and zero-length body without auth', async () => {
      const res = await app.inject({
        method: 'HEAD',
        url: '/',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['x-service-name']).toBe('payroute-engine');
      expect(res.headers['x-service-status']).toBe('ok');
      expect(res.headers['x-uptime-seconds']).toBeDefined();
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.body).toBe('');
    });

    it('GET / returns HTTP 200 with JSON payload', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/',
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.status).toBe('ok');
      expect(json.service).toBe('PayRoute Engine');
      expect(json.version).toBe('0.1.0');
      expect(json.timestamp).toBeDefined();
    });
  });

  describe('HEAD /health (Health check probe)', () => {
    it('returns HTTP 200 with monitoring headers and zero-length body without auth', async () => {
      const res = await app.inject({
        method: 'HEAD',
        url: '/health',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['x-service-name']).toBe('payroute-engine');
      expect(res.headers['x-service-status']).toBe('ok');
      expect(res.headers['x-uptime-seconds']).toBeDefined();
      expect(res.body).toBe('');
    });

    it('GET /health returns HTTP 200 with JSON status ok', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.status).toBe('ok');
      expect(json.timestamp).toBeDefined();
    });
  });

  describe('HEAD /live (Liveness probe)', () => {
    it('returns HTTP 200 with monitoring headers and zero-length body without auth', async () => {
      const res = await app.inject({
        method: 'HEAD',
        url: '/live',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['x-service-name']).toBe('payroute-engine');
      expect(res.headers['x-service-status']).toBe('ok');
      expect(res.headers['x-uptime-seconds']).toBeDefined();
      expect(res.body).toBe('');
    });

    it('GET /live returns HTTP 200 with JSON status ok', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/live',
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.status).toBe('ok');
    });
  });

  describe('HEAD /ready (Readiness probe)', () => {
    it('returns zero-length body on HEAD request', async () => {
      const res = await app.inject({
        method: 'HEAD',
        url: '/ready',
      });

      expect([200, 503]).toContain(res.statusCode);
      expect(res.headers['x-service-name']).toBe('payroute-engine');
      expect(res.headers['x-service-status']).toBeDefined();
      expect(res.body).toBe('');
    });

    it('returns degraded status header when health tracker reports degradation', async () => {
      mockHealthTrackerDegraded = true;
      const res = await app.inject({
        method: 'HEAD',
        url: '/ready',
      });

      // Degraded returns 200 or 503 depending on DB, but header is set accordingly
      expect([200, 503]).toContain(res.statusCode);
      expect(['degraded', 'down']).toContain(res.headers['x-service-status']);
      expect(res.body).toBe('');
      mockHealthTrackerDegraded = false;
    });
  });

  describe('Query params & trailing URL compatibility for probes', () => {
    it('handles monitoring probes with query parameters without authentication', async () => {
      const res = await app.inject({
        method: 'HEAD',
        url: '/health?format=summary&probe=liveness',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['x-service-name']).toBe('payroute-engine');
      expect(res.headers['x-service-status']).toBe('ok');
      expect(res.body).toBe('');
    });

    it('handles root probe with query parameters without authentication', async () => {
      const res = await app.inject({
        method: 'HEAD',
        url: '/?monitor=uptime-robot',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['x-service-name']).toBe('payroute-engine');
      expect(res.headers['x-service-status']).toBe('ok');
      expect(res.body).toBe('');
    });
  });

  describe('Security & Authentication boundaries', () => {
    it('rejects protected endpoints when API key is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/payments',
        payload: { amount_minor: 1000, currency: 'INR' },
      });

      expect(res.statusCode).toBe(401);
      const json = JSON.parse(res.body);
      expect(json.error).toBe('Unauthorized');
    });

    it('CORS preflight reflects allowed methods including HEAD', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/',
        headers: {
          'Origin': 'https://dashboard.example.com',
          'Access-Control-Request-Method': 'HEAD',
        },
      });

      expect(res.statusCode).toBe(204);
      const allowMethods = res.headers['access-control-allow-methods'];
      expect(allowMethods).toContain('HEAD');
    });
  });
});
