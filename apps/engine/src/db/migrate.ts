import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Forward-only SQL migration runner.
 * Ensures migrations run inside a single transaction and records applied migrations in schema_migrations.
 */
export async function runMigrations(): Promise<string[]> {
  const client = await pool.connect();
  const appliedMigrations: string[] = [];

  try {
    // 1. Ensure migrations tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 2. Locate migrations directory (check relative to __dirname and process.cwd())
    let migrationsDir = path.resolve(__dirname, '../../../../migrations');
    try {
      await fs.access(migrationsDir);
    } catch {
      migrationsDir = path.resolve(process.cwd(), 'migrations');
    }
    const files = await fs.readdir(migrationsDir);
    const sqlFiles = files.filter((f) => f.endsWith('.sql')).sort();

    // 3. Apply each unapplied migration sequentially
    for (const file of sqlFiles) {
      const { rows } = await client.query(
        'SELECT version FROM schema_migrations WHERE version = $1',
        [file]
      );

      if (rows.length === 0) {
        const filePath = path.join(migrationsDir, file);
        const sql = await fs.readFile(filePath, 'utf8');

        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query(
            'INSERT INTO schema_migrations (version) VALUES ($1)',
            [file]
          );
          await client.query('COMMIT');
          appliedMigrations.push(file);
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`Failed to apply migration "${file}": ${(err as Error).message}`);
        }
      }
    }

    return appliedMigrations;
  } finally {
    client.release();
  }
}
