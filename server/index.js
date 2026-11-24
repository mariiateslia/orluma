import { createApplication } from './app.js';
process.umask(0o077);
const { app, close } = await createApplication();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const server = app.listen(port, host, () =>
  console.log(`Orluma is running at ${process.env.APP_URL || `http://localhost:${port}`}`),
);
function shutdown() {
  server.close(async () => {
    await close();
    process.exit(0);
  });
  setTimeout(async () => {
    await close();
    process.exit(0);
  }, 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
