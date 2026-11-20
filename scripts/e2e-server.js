import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/app.js';
const directory = mkdtempSync(join(tmpdir(), 'orluma-browser-'));
const { app, close } = createApplication({
  dbPath: join(directory, 'browser.sqlite'),
  appUrl: 'http://127.0.0.1:3117',
  disableRateLimit: true,
});
const server = app.listen(3117, '127.0.0.1', () =>
  console.log('Orluma browser tests: http://127.0.0.1:3117'),
);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  close();
  server.closeAllConnections();
  server.close(() => {
    rmSync(directory, { recursive: true, force: true });
    process.exit(0);
  });
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
