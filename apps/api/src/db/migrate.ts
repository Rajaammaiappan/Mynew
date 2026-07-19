/** Minimal forward-only migration runner: applies migrations/NNNN_*.sql in order. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { CONFIG } from '../config';

async function main() {
  const pool = new Pool({ connectionString: CONFIG.databaseUrl });
  await pool.query(`CREATE TABLE IF NOT EXISTS _migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const dir = join(__dirname, '../../../../migrations');
  const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  for (const f of files) {
    const done = await pool.query('SELECT 1 FROM _migrations WHERE name=$1', [f]);
    if (done.rowCount) continue;
    console.log(`applying ${f}`);
    await pool.query(readFileSync(join(dir, f), 'utf8'));
    await pool.query('INSERT INTO _migrations(name) VALUES ($1)', [f]);
  }
  await pool.end();
  console.log('migrations up to date');
}
main().catch((e) => { console.error(e); process.exit(1); });
