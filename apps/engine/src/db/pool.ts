import pg from 'pg';
const { Pool } = pg;

export function sanitizeConnectionUrl(url?: string): string | undefined {
  if (!url) return undefined;
  let cleaned = url.trim();
  // Strip variable name prefix if accidentally pasted (e.g. DATABASE_URL=... or REDIS_URL=...)
  cleaned = cleaned.replace(/^[A-Z0-9_]+\s*=\s*/i, '').trim();
  // Strip surrounding quotes: ", ', `
  cleaned = cleaned.replace(/^["'`]+|["'`]+$/g, '').trim();
  // Strip trailing encoded quotes (%22 or %27) if present
  cleaned = cleaned.replace(/(%22|%27)+$/gi, '').trim();
  // Strip surrounding quotes again if wrapped in nested quotes
  cleaned = cleaned.replace(/^["'`]+|["'`]+$/g, '').trim();

  // If someone pasted a host without protocol scheme:
  if (
    cleaned.includes('neon.tech') &&
    !cleaned.startsWith('postgres://') &&
    !cleaned.startsWith('postgresql://')
  ) {
    cleaned = `postgresql://${cleaned.replace(/^\/+/, '')}`;
  }
  return cleaned || undefined;
}

const rawDbUrl = process.env.DATABASE_URL;
const connectionString =
  sanitizeConnectionUrl(rawDbUrl) ||
  'postgres://payroute:payroute_secret@localhost:5433/payroute';

/**
 * Shared PostgreSQL connection pool.
 * Note: pg driver parses BIGINT (OID 20) as string by default,
 * which preserves exact precision for our BigInt minor units.
 */
const isSsl =
  connectionString.includes('sslmode=require') ||
  connectionString.includes('sslmode=verify-full') ||
  connectionString.includes('neon.tech') ||
  connectionString.includes('supabase.co') ||
  connectionString.includes('render.com');

export const pool = new Pool({
  connectionString,
  max: 12,
  idleTimeoutMillis: 1000,
  connectionTimeoutMillis: 10000,
  ...(isSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

pool.on('error', (err) => {
  console.warn('[Postgres Pool] Idle client warning:', err.message);
});

/**
 * Execute a callback within an isolated database transaction.
 * Automatically handles BEGIN, COMMIT, and ROLLBACK.
 */
export async function withTransaction<T>(
  callback: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
