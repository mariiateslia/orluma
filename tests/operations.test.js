import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../server/database.js';
import { hashPassword, checkPassword } from '../server/security.js';

test('online backup includes committed WAL data, can be restored and refuses overwrite', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'orluma-ops-'));
  const db = openDatabase(join(directory, 'orluma.sqlite'));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.prepare('INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)').run(
    'test-user',
    'owner@example.test',
    'Test owner',
    await hashPassword('original-test-passphrase'),
    '2026-11-20T12:00:00Z',
  );
  const destination = join(directory, 'snapshot.sqlite');
  const run = () =>
    spawnSync(process.execPath, ['scripts/backup.js', destination], {
      cwd: resolve('.'),
      env: { ...process.env, DATA_DIR: directory },
      encoding: 'utf8',
    });
  assert.equal(run().status, 0);
  const restored = new DatabaseSync(destination, { readOnly: true });
  assert.equal(restored.prepare('SELECT name FROM users').get().name, 'Test owner');
  assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  restored.close();
  assert.equal(statSync(destination).mode & 0o777, 0o600);
  db.prepare('UPDATE users SET name=?').run('Changed after backup');
  assert.equal(run().status, 1);
  const unchanged = new DatabaseSync(destination, { readOnly: true });
  assert.equal(unchanged.prepare('SELECT name FROM users').get().name, 'Test owner');
  unchanged.close();
});

test('operator recovery hashes the new password, revokes sessions and never logs the password', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'orluma-recovery-'));
  const db = openDatabase(join(directory, 'orluma.sqlite'));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.prepare('INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)').run(
    'test-user',
    'owner@example.test',
    'Test owner',
    await hashPassword('original-test-passphrase'),
    '2026-11-20T12:00:00Z',
  );
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(
    'test-hash',
    'test-user',
    Date.now() + 60000,
    '2026-11-20T12:00:00Z',
  );
  const password = 'recovered-test-passphrase';
  const result = spawnSync(
    process.execPath,
    ['scripts/reset-password.js', 'OWNER@example.test', '--stdin'],
    { input: password + '\n', env: { ...process.env, DATA_DIR: directory }, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(password));
  assert.equal(
    await checkPassword(
      password,
      db.prepare('SELECT password_hash FROM users').get().password_hash,
    ),
    true,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
});
