import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { hashPassword } from '../server/security.js';
import { transaction } from '../server/database.js';

async function secret(prompt) {
  process.stdout.write(prompt);
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  try {
    return await new Promise((resolve, reject) => {
      rl.once('SIGINT', () => reject(new Error('Cancelled.')));
      rl.question('', resolve);
    });
  } finally {
    rl.close();
    process.stdout.write('\n');
  }
}

// Server-operator recovery, deliberately unavailable over HTTP.
// Stop Orluma first so every open session/stream is revoked immediately.
process.umask(0o077);
let db;
try {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email || process.argv.length > 4 || (process.argv[3] && process.argv[3] !== '--stdin'))
    throw new Error('Usage: npm run reset-password -- person@example.com [--stdin]');
  let password;
  if (process.argv[3] === '--stdin') {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (input.length > 256) throw new Error('Password is too long.');
    }
    password = input.replace(/\r?\n$/, '');
  } else {
    if (!process.stdin.isTTY)
      throw new Error('Use an interactive terminal, or explicitly pass --stdin.');
    password = await secret('New password (hidden): ');
    if (password !== (await secret('Confirm password (hidden): ')))
      throw new Error('Passwords do not match.');
  }
  if (password.length < 12 || password.length > 128 || /[\r\n]/.test(password))
    throw new Error('Use a password of 12–128 characters on one line.');
  // Opening an existing file only avoids accidentally creating an empty installation.
  const { existsSync } = await import('node:fs');
  const path = resolve(process.env.DATA_DIR || './data', 'orluma.sqlite');
  if (!existsSync(path)) throw new Error('Database not found. Check DATA_DIR.');
  db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const user = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (!user) throw new Error('Account not found.');
  const hash = await hashPassword(password);
  transaction(db, () => {
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
  });
  console.log('Password reset. All sessions for this account have been revoked.');
} catch (error) {
  console.error(`Password reset failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  db?.close();
}
