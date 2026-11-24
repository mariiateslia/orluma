import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openDatabase, transaction, now } from '../server/database.js';
export const domainTables = [
  'workspaces',
  'memberships',
  'invitations',
  'projects',
  'allocations',
  'tasks',
  'documents',
  'spend_requests',
  'expenses',
  'comments',
  'activity',
];
export async function importSQLite(db, sourcePath) {
  const legacy = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    return await transaction(db, async () => {
      for (const table of ['users', ...domainTables])
        if ((await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).count)
          throw new Error(
            'Target contains data. Import requires a fresh database; no records were changed.',
          );
      const counts = {};
      const users = legacy.prepare('SELECT * FROM users').all();
      for (const user of users) {
        await db
          .prepare(
            'INSERT INTO users(id,email,name,email_verified,created_at,updated_at) VALUES(?,?,?,?,?,?)',
          )
          .run(
            user.id,
            user.email.toLowerCase(),
            user.name,
            false,
            user.created_at,
            user.created_at,
          );
        await db
          .prepare(
            'INSERT INTO auth_accounts(id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
          )
          .run(
            randomUUID(),
            user.id,
            'credential',
            user.id,
            user.password_hash,
            user.created_at,
            user.created_at,
          );
      }
      counts.users = users.length;
      for (const table of domainTables) {
        const records = legacy.prepare(`SELECT * FROM ${table}`).all();
        for (const original of records) {
          const record = { ...original };
          if (table === 'invitations' && !record.used_at) record.revoked_at = now();
          const columns = Object.keys(record);
          if (columns.some((column) => !/^[a-z_]+$/.test(column)))
            throw new Error('Unsupported source schema.');
          await db
            .prepare(
              `INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
            )
            .run(...Object.values(record));
        }
        counts[table] = records.length;
      }
      // Authentication sessions never migrate; users confirm their email before returning.
      return counts;
    });
  } finally {
    legacy.close();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let db;
  try {
    if (!process.argv[2])
      throw new Error('Usage: npm run import:sqlite -- /absolute/path/orluma.sqlite');
    db = await openDatabase();
    const counts = await importSQLite(db, resolve(process.argv[2]));
    console.log('Import committed. Counts:', JSON.stringify(counts));
    console.log(
      'Old sessions and outstanding invitations are invalidated. Users must confirm their email.',
    );
  } catch (error) {
    console.error('Import failed: ' + error.message);
    process.exitCode = 1;
  } finally {
    await db?.close();
  }
}
