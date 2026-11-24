import { mkdir, open, chmod, link, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { postgresEnvironment } from './postgres-env.js';
process.umask(0o077);
const destination = resolve(process.argv[2] || `backups/orluma-${Date.now()}.dump`),
  temporary = destination + '.' + randomUUID() + '.partial';
let file;
try {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  file = await open(temporary, 'wx', 0o600);
  const child = spawn(
    process.env.PG_DUMP_BIN || 'pg_dump',
    ['--format=custom', '--no-owner', '--no-acl'],
    {
      env: postgresEnvironment(process.env.DATABASE_URL),
      stdio: ['ignore', file.fd, 'pipe'],
    },
  );
  child.stderr.resume();
  const [code] = await once(child, 'close');
  if (code !== 0)
    throw new Error('pg_dump failed. Check the connection and PostgreSQL client version.');
  await file.close();
  file = null;
  await chmod(temporary, 0o600);
  await link(temporary, destination);
  console.log(`Backup created: ${destination}`);
} catch (error) {
  console.error('Backup failed: ' + error.message);
  process.exitCode = 1;
} finally {
  await file?.close();
  await unlink(temporary).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}
