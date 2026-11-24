import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { openDatabase } from '../server/database.js';
import { openDatabase as openLegacy } from '../scripts/legacy-database.js';
import { importSQLite } from '../scripts/import-sqlite.js';
import { hashPassword as legacyHash, checkPassword } from '../server/security.js';
import { hashPassword, verifyPassword } from 'better-auth/crypto';

async function fixture(t) {
  const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required. The test role needs CREATEDB.');
  const control = new pg.Pool({ connectionString: url });
  const name = 'orluma_test_' + randomUUID().replaceAll('-', '');
  await control.query(`CREATE DATABASE ${name}`);
  const databaseUrl = new URL(url);
  databaseUrl.pathname = '/' + name;
  const db = await openDatabase(databaseUrl.toString());
  const directory = mkdtempSync(join(tmpdir(), 'orluma-ops-'));
  t.after(async () => {
    await db.close();
    await control.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await control.end();
    rmSync(directory, { recursive: true, force: true });
  });
  return { db, url: databaseUrl.toString(), directory, control };
}

test('PostgreSQL backup restores committed data and refuses overwrite or nonempty restore', async (t) => {
  const f = await fixture(t),
    userId = randomUUID();
  await f.db
    .prepare('INSERT INTO users(id,email,name,email_verified) VALUES(?,?,?,?)')
    .run(userId, 'owner@example.test', 'Test owner', true);
  await f.db
    .prepare(
      'INSERT INTO auth_accounts(id,user_id,account_id,provider_id,password,updated_at) VALUES(?,?,?,?,?,now())',
    )
    .run(
      randomUUID(),
      userId,
      userId,
      'credential',
      await hashPassword('original-test-passphrase'),
    );
  const destination = join(f.directory, 'snapshot.dump');
  const run = () =>
    spawnSync(process.execPath, ['scripts/backup.js', destination], {
      env: { ...process.env, DATABASE_URL: f.url },
      encoding: 'utf8',
    });
  const backup = run();
  assert.equal(backup.status, 0, backup.stderr);
  assert.equal(statSync(destination).mode & 0o777, 0o600);
  assert.equal(run().status, 1);
  const target = 'orluma_restore_' + randomUUID().replaceAll('-', '');
  await f.control.query(`CREATE DATABASE ${target}`);
  const targetUrl = new URL(f.url);
  targetUrl.pathname = '/' + target;
  try {
    const restore = () =>
      spawnSync(process.execPath, ['scripts/restore.js', destination], {
        env: { ...process.env, DATABASE_URL: targetUrl.toString() },
        encoding: 'utf8',
      });
    const result = restore();
    assert.equal(result.status, 0, result.stderr);
    const restored = await openDatabase(targetUrl.toString());
    assert.equal((await restored.prepare('SELECT name FROM users').get()).name, 'Test owner');
    await restored.close();
    assert.equal(restore().status, 1);
  } finally {
    await f.control.query(`DROP DATABASE ${target} WITH (FORCE)`);
  }
});

test('SQLite import preserves IDs and exact cents, invalidates old sessions and refuses a populated target', async (t) => {
  const f = await fixture(t),
    source = join(f.directory, 'old.sqlite'),
    old = openLegacy(source),
    userId = randomUUID(),
    workspaceId = randomUUID();
  const password = 'legacy-test-passphrase';
  old
    .prepare('INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)')
    .run(
      userId,
      'owner@example.test',
      'Legacy owner',
      await legacyHash(password),
      '2026-11-20T12:00:00Z',
    );
  old
    .prepare('INSERT INTO workspaces(id,name,is_sample,created_by,created_at) VALUES(?,?,?,?,?)')
    .run(workspaceId, 'Legacy team', 0, userId, '2026-11-20T12:00:00Z');
  old
    .prepare('INSERT INTO memberships(workspace_id,user_id,role,joined_at) VALUES(?,?,?,?)')
    .run(workspaceId, userId, 'owner', '2026-11-20T12:00:00Z');
  const projectId = randomUUID();
  old
    .prepare(
      'INSERT INTO projects(id,workspace_id,name,currency,budget_cents,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run(
      projectId,
      workspaceId,
      'Large exact budget',
      'USD',
      98765432100,
      userId,
      '2026-11-20T12:00:00Z',
      '2026-11-20T12:00:00Z',
    );
  old
    .prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
    .run('old-hash', userId, Date.now() + 60000, '2026-11-20T12:00:00Z');
  old.close();
  const counts = await importSQLite(f.db, source);
  assert.equal(counts.users, 1);
  assert.equal(counts.projects, 1);
  assert.equal(
    (await f.db.prepare('SELECT budget_cents FROM projects WHERE id=?').get(projectId))
      .budget_cents,
    98765432100,
  );
  assert.equal(
    (await f.db.prepare('SELECT email_verified FROM users').get()).email_verified,
    false,
  );
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get()).count, 0);
  assert(
    await checkPassword(
      password,
      (await f.db.prepare('SELECT password FROM auth_accounts').get()).password,
    ),
  );
  await assert.rejects(importSQLite(f.db, source), /Target contains data/);
  const unchanged = openLegacy(source);
  assert.equal(unchanged.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1);
  unchanged.close();
});

test('operator recovery replaces the credential hash and revokes sessions without logging the password', async (t) => {
  const f = await fixture(t),
    userId = randomUUID();
  await f.db
    .prepare('INSERT INTO users(id,email,name,email_verified) VALUES(?,?,?,?)')
    .run(userId, 'owner@example.test', 'Test owner', true);
  await f.db
    .prepare(
      'INSERT INTO auth_accounts(id,user_id,account_id,provider_id,password,updated_at) VALUES(?,?,?,?,?,now())',
    )
    .run(
      randomUUID(),
      userId,
      userId,
      'credential',
      await hashPassword('original-test-passphrase'),
    );
  await f.db
    .prepare(
      "INSERT INTO auth_sessions(id,user_id,token,expires_at,updated_at) VALUES(?,?,?,now()+interval '1 hour',now())",
    )
    .run(randomUUID(), userId, 'old-session-token');
  const password = 'recovered-test-passphrase';
  const result = spawnSync(
    process.execPath,
    ['scripts/reset-password.js', 'OWNER@example.test', '--stdin'],
    { input: password + '\n', env: { ...process.env, DATABASE_URL: f.url }, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert(!result.stdout.includes(password));
  assert(!result.stderr.includes(password));
  assert(
    await verifyPassword({
      password,
      hash: (await f.db.prepare('SELECT password FROM auth_accounts').get()).password,
    }),
  );
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get()).count, 0);
});
