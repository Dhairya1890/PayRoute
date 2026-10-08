import fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { apiRoutes, RouteDependencies } from './routes.js';
import { labRoutes } from './lab-routes.js';
import { chatRoutes } from './chat-routes.js';
import { authenticateApiKey } from './auth.js';

export interface BuildAppOptions extends RouteDependencies {
  disableAuth?: boolean;
}

/**
 * Builds and configures the PayRoute Engine Fastify application.
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = fastify({
    logger: false,
  });

  // 1. CORS plugin
  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'idempotency-key', 'x-business-id'],
    exposedHeaders: ['x-service-status', 'x-service-name', 'x-service-version', 'x-uptime-seconds'],
  });

  // 2. Authentication hook (unless explicitly disabled for testing)
  if (!options.disableAuth) {
    app.addHook('preHandler', authenticateApiKey);
  }

  // 3. Register API routes
  await app.register(apiRoutes(options));

  // 4. Register Lab routes (when PROVIDER_TARGET=lab)
  await app.register(labRoutes(options));

  // 5. Register Chatbot AI routes
  await app.register(chatRoutes);

  return app;
}
