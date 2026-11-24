import pg from 'pg';
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
let db;
try {
  if (!process.env.DATABASE_URL || !process.argv[2])
    throw new Error('Usage: DATABASE_URL=<empty target> npm run restore -- backup.dump');
  await access(process.argv[2]);
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const result = await db.query(
    "SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_schema NOT LIKE 'pg_toast%' AND table_schema NOT LIKE 'pg_temp_%' AND table_type='BASE TABLE'",
  );
  if (result.rows[0].count)
    throw new Error('Target database is not empty. Restore into a new database.');
  const connection = new URL(process.env.DATABASE_URL);
  const child = spawn(
    process.env.PG_RESTORE_BIN || 'pg_restore',
    [
      '--exit-on-error',
      '--single-transaction',
      '--no-owner',
      '--no-acl',
      '--dbname',
      decodeURIComponent(connection.pathname.slice(1)),
      process.argv[2],
    ],
    {
      env: {
        ...process.env,
        PGHOST: connection.hostname,
        PGPORT: connection.port || '5432',
        PGUSER: decodeURIComponent(connection.username),
        PGPASSWORD: decodeURIComponent(connection.password),
        PGSSLMODE: connection.searchParams.get('sslmode') || 'prefer',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  child.stderr.resume();
  const [code] = await once(child, 'close');
  if (code !== 0)
    throw new Error('pg_restore failed. Check the backup, target and client version.');
  console.log('Backup restored. Start Orluma with this DATABASE_URL.');
} catch (error) {
  console.error('Restore failed: ' + error.message);
  process.exitCode = 1;
} finally {
  await db?.end();
}
