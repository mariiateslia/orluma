import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { hashPassword } from 'better-auth/crypto';
import { openDatabase, transaction } from '../server/database.js';

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
  db = await openDatabase();
  const user = await db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (!user) throw new Error('Account not found.');
  const hash = await hashPassword(password);
  await transaction(db, async () => {
    const changed = await db
      .prepare(
        "UPDATE auth_accounts SET password=?,updated_at=now() WHERE user_id=? AND provider_id='credential'",
      )
      .run(hash, user.id);
    if (changed.changes !== 1) throw new Error('Credential account not found.');
    await db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(user.id);
    await db
      .prepare(
        "DELETE FROM auth_verifications WHERE value=? AND identifier LIKE 'reset-password:%'",
      )
      .run(user.id);
  });
  console.log('Password reset. All sessions for this account have been revoked.');
} catch (error) {
  console.error(`Password reset failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await db?.close();
}
