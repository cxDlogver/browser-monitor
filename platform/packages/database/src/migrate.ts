import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

async function migrate(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required.');

  const pool = new Pool({ connectionString, max: 1 });
  const migrationDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS monitor_schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const appliedRows = await pool.query<{ name: string }>('SELECT name FROM monitor_schema_migrations');
    const applied = new Set(appliedRows.rows.map((row) => row.name));
    const files = (await readdir(migrationDirectory)).filter((name) => name.endsWith('.sql')).sort();

    for (const name of files) {
      if (applied.has(name)) continue;
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO monitor_schema_migrations(name) VALUES ($1)', [name]);
        await client.query('COMMIT');
        process.stdout.write(`Applied ${name}\n`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

await migrate();

