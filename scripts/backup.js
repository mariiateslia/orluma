import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, linkSync, unlinkSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// SQLite's online backup API includes committed WAL transactions.
// Publish via a hard link so an existing backup can never be overwritten.
process.umask(0o077);
const sourcePath = resolve(process.env.DATA_DIR || './data', 'orluma.sqlite');
const destination = resolve(
  process.argv[2] || `backups/orluma-${new Date().toISOString().replaceAll(':', '-')}.sqlite`,
);
const temporary = `${destination}.${randomUUID()}.partial`;
let db;
try {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  db = new DatabaseSync(sourcePath, { readOnly: true });
  await backup(db, temporary);
  chmodSync(temporary, 0o600);
  linkSync(temporary, destination);
  console.log(`Backup created: ${destination}`);
} catch (error) {
  console.error(`Backup failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  db?.close();
  try {
    unlinkSync(temporary);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
