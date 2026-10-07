import pg from 'pg';
const { Pool } = pg;

const connectionString =
  process.env.DATABASE_URL || 'postgres://payroute:payroute_secret@localhost:5433/payroute';

/**
 * Shared PostgreSQL connection pool.
 * Note: pg driver parses BIGINT (OID 20) as string by default,
 * which preserves exact precision for our BigInt minor units.
 */
const isSsl =
  connectionString.includes('sslmode=require') ||
  connectionString.includes('neon.tech') ||
  connectionString.includes('supabase.co');

export const pool = new Pool({
  connectionString,
  max: 12,
  idleTimeoutMillis: 1000,
  connectionTimeoutMillis: 10000,
  ...(isSsl ? { ssl: { rejectUnauthorized: false } } : {}),
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
