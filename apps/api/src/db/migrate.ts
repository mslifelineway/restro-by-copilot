import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { config } from '../config';

/** Applies pending SQL migrations as the owner role. Exported so e2e tests can reuse it. */
export async function runMigrations(): Promise<string[]> {
  const client = new Client({ connectionString: config.databaseOwnerUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    await client.query('SELECT pg_advisory_lock(727001)');
    const dir = join(__dirname, 'migrations');
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
      }
    }
    // keep app role password in sync with env (the SQL file only sets a dev default)
    await client.query(`ALTER ROLE rms_app PASSWORD '${config.appDbPassword.replace(/'/g, "''")}'`);
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
    await client.end();
  }
  return applied;
}

if (require.main === module) {
  runMigrations()
    .then((a) => console.log(a.length ? `Applied: ${a.join(', ')}` : 'No pending migrations'))
    .catch((e) => { console.error(e); process.exit(1); });
}
