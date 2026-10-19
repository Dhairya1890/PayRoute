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
  // Only exact operational probe paths are public. Application endpoints,
  // including config and chat, require credentials.
  const publicPaths = new Set(['/', '/health', '/ready', '/live']);
  const urlPath = req.url.split('?')[0] || '/';
  if (publicPaths.has(urlPath)) {
    return;
  }

  const configuredKey = process.env.ENGINE_API_KEY;
  if (!configuredKey) {
    reply.status(503).send({
      error: 'ServiceUnavailable',
      message: 'API authentication is not configured',
    });
    return;
  }

  const authHeader = req.headers['authorization'];
  const apiKeyHeader = req.headers['x-api-key'] as string;

  let providedKey: string | null = null;
  if (apiKeyHeader) {
    providedKey = apiKeyHeader;
  } else if (authHeader && authHeader.startsWith('Bearer ')) {
    providedKey = authHeader.slice(7).trim();
  }

  if (!providedKey || !timingSafeEqualStrings(providedKey, configuredKey)) {
    console.warn(`[Auth] ⚠️ Rejected unauthorized ${req.method} ${req.url} (provided key: ${providedKey ? 'mismatched' : 'none'})`);
    reply.status(401).send({
      error: 'Unauthorized',
      message: 'Invalid or missing ENGINE_API_KEY',
    });
  }
}
