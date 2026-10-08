import crypto from 'node:crypto';
import { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Constant-time string equality check to prevent timing side-channel attacks on API key verification.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Prevent timing leak on length mismatch by comparing with self before returning false
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * API Key Authentication Middleware for PayRoute Engine.
 * Expects `x-api-key` header or `Authorization: Bearer <key>`.
 */
export async function authenticateApiKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Public health/readiness/liveness/monitoring/config/chat endpoints do not require auth
  const publicPaths = ['/', '/health', '/ready', '/live', '/config', '/chat'];
  const urlPath = req.url.split('?')[0] || '';
  if (publicPaths.some((p) => urlPath === p || (p !== '/' && urlPath.startsWith(`${p}/`)))) {
    return;
  }

  const configuredKey = process.env.ENGINE_API_KEY || 'pr_test_engine_key_secret';

  const authHeader = req.headers['authorization'];
  const apiKeyHeader = req.headers['x-api-key'] as string;
  const queryApiKey = (req.query as any)?.api_key as string | undefined;

  let providedKey: string | null = null;
  if (apiKeyHeader) {
    providedKey = apiKeyHeader;
  } else if (authHeader && authHeader.startsWith('Bearer ')) {
    providedKey = authHeader.slice(7).trim();
  } else if (queryApiKey) {
    providedKey = queryApiKey;
  }

  if (!providedKey || !timingSafeEqualStrings(providedKey, configuredKey)) {
    console.warn(`[Auth] ⚠️ Rejected unauthorized ${req.method} ${req.url} (provided key: ${providedKey ? 'mismatched' : 'none'})`);
    reply.status(401).send({
      error: 'Unauthorized',
      message: 'Invalid or missing ENGINE_API_KEY',
    });
  }
}
