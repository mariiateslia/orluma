import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

const { Pool, types } = pg;
// Monetary amounts and epoch milliseconds remain exact JavaScript integers.
types.setTypeParser(20, (value) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('Database integer exceeds safe range.');
  return number;
});
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const camel = (row) =>
  row &&
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
export const rows = (values) => values.map(camel);

function parameterize(sql) {
  let index = 0;
  let quoted = false;
  return sql.replace(/''|'|\?/g, (part) => {
    if (part === "''") return part;
    if (part === "'") {
      quoted = !quoted;
      return part;
    }
    return quoted ? part : '$' + ++index;
  });
}
export async function openDatabase(connectionString = process.env.DATABASE_URL, options = {}) {
  if (!connectionString) throw new Error('DATABASE_URL is required. See docs/SELF_HOSTING.md.');
  const pool = new Pool({
    connectionString,
    max: options.max || 10,
    ...(options.schema ? { options: `-c search_path=${options.schema},public` } : {}),
  });
  const context = new AsyncLocalStorage();
  const query = (sql, values) => (context.getStore() || pool).query(sql, values);
  const db = {
    pool,
    context,
    prepare(sql) {
      const text = parameterize(sql);
      return {
        async get(...values) {
          return (await query(text, values)).rows[0];
        },
        async all(...values) {
          return (await query(text, values)).rows;
        },
        async run(...values) {
          const result = await query(text, values);
          return { changes: result.rowCount };
        },
      };
    },
    async exec(sql) {
      return query(sql);
    },
    async close() {
      await pool.end();
    },
  };
  try {
    await migrate(db);
    return db;
  } catch (error) {
    await pool.end();
    throw error;
  }
}
async function migrate(db) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(71649012)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_versions(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    );
    const directory = new URL('./migrations/', import.meta.url);
    for (const file of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
      if ((await client.query('SELECT 1 FROM schema_versions WHERE version=$1', [file])).rowCount)
        continue;
      await client.query(await readFile(new URL(file, directory), 'utf8'));
      await client.query('INSERT INTO schema_versions(version) VALUES($1)', [file]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function transaction(db, fn) {
  if (db.context.getStore()) return fn();
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const value = await db.context.run(client, fn);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export { projectBudget, audit, seedSampleProject } from './domain.js';
