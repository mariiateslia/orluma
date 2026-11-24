// Test-only mail capture lives on a separate loopback server, never in the app.
import pg from 'pg';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../server/app.js';
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL for browser tests.');
const schema = 'browser_' + randomUUID().replaceAll('-', ''),
  control = new pg.Pool({ connectionString: databaseUrl });
await control.query(`CREATE SCHEMA ${schema}`);
const messages = [];
const { app, close } = await createApplication({
  databaseUrl,
  databaseSchema: schema,
  appUrl: 'http://127.0.0.1:3117',
  authSecret: 'test-only-browser-secret-'.repeat(3),
  mailFrom: 'Orluma <no-reply@example.test>',
  mailTransport: async (message) => messages.push(message),
  disableRateLimit: true,
  registrationMode: 'invite',
});
const capture = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(messages));
}).listen(3118, '127.0.0.1');
const server = app.listen(3117, '127.0.0.1', () =>
  console.log('Orluma browser tests: http://127.0.0.1:3117'),
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.closeAllConnections();
  capture.closeAllConnections();
  await Promise.all([
    new Promise((resolve) => server.close(resolve)),
    new Promise((resolve) => capture.close(resolve)),
  ]);
  await close();
  await control.query(`DROP SCHEMA ${schema} CASCADE`);
  await control.end();
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
