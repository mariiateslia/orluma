import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createApplication } from '../server/app.js';

export const ORIGIN = 'http://localhost:3000';
export const PASSWORD = 'a-long-test-password-2026';
export async function databaseFixture(t) {
  const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString)
    throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database.');
  const schema = 'test_' + randomUUID().replaceAll('-', '');
  const control = new pg.Pool({ connectionString });
  await control.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => {
    await control.query(`DROP SCHEMA ${schema} CASCADE`);
    await control.end();
  });
  return { databaseUrl: connectionString, databaseSchema: schema };
}
export async function applicationFixture(t, options = {}) {
  let cleanup;
  const config = await databaseFixture({
    after: (fn) => {
      cleanup = fn;
    },
  });
  const messages = [];
  let runtime, server, base;
  async function start() {
    runtime = await createApplication({
      ...config,
      appUrl: ORIGIN,
      authSecret: 'test-secret-'.repeat(5),
      mailFrom: 'Orluma <no-reply@example.test>',
      mailTransport: async (message) => messages.push(message),
      disableRateLimit: true,
      disableMailWorker: true,
      registrationMode: 'invite',
      ...options,
    });
    server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await runtime.close();
  }
  await start();
  // node:test after hooks run in registration order; close before dropping schema.
  t.after(async () => {
    await stop();
    await cleanup();
  });
  function client() {
    const cookies = new Map();
    const self = {
      get cookie() {
        return [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
      },
      async request(path, method = 'GET', body, extraHeaders = {}) {
        const response = await fetch(base + path, {
          method,
          redirect: 'manual',
          headers: {
            Origin: ORIGIN,
            ...(self.cookie ? { Cookie: self.cookie } : {}),
            ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
            ...extraHeaders,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        for (const cookie of response.headers.getSetCookie()) {
          const part = cookie.split(';')[0];
          const at = part.indexOf('=');
          cookies.set(part.slice(0, at), part.slice(at + 1));
        }
        const text = await response.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          data = { text };
        }
        return { status: response.status, data, headers: response.headers };
      },
      async stream(workspaceId) {
        return fetch(base + `/api/workspaces/${workspaceId}/events`, {
          headers: { Cookie: self.cookie, Origin: ORIGIN },
        });
      },
    };
    return self;
  }
  async function verify(email, person = client()) {
    await runtime.mail.flush();
    const message = messages.filter((m) => m.to === email && m.subject.includes('Confirm')).at(-1);
    if (!message) throw new Error('Verification email was not delivered to local transport.');
    const url = new URL(message.text.match(/https?:\/\/\S+/)[0]);
    return person.request(url.pathname + url.search);
  }
  async function register(person, { email, name = 'Test user', password = PASSWORD, inviteToken }) {
    const signup = await person.request(
      '/api/identity/sign-up/email',
      'POST',
      { email, name, password, callbackURL: ORIGIN + '/?verified=1' },
      inviteToken ? { 'x-orluma-invitation': inviteToken } : {},
    );
    if (signup.status !== 200) return signup;
    const confirmation = await verify(email, person);
    if (confirmation.status !== 302)
      throw new Error('Email confirmation failed: ' + JSON.stringify(confirmation));
    const signin = await person.request('/api/identity/sign-in/email', 'POST', { email, password });
    if (signin.status !== 200) return signin;
    let workspaceId;
    if (inviteToken) {
      const accepted = await person.request('/api/invitations/accept', 'POST', {
        token: inviteToken,
      });
      if (accepted.status !== 200) return accepted;
      workspaceId = accepted.data.workspaceId;
    }
    return { ...signin, status: 201, data: { ...signin.data, workspaceId } };
  }
  return {
    get runtime() {
      return runtime;
    },
    messages,
    client,
    verify,
    register,
    restart: async () => {
      await stop();
      await start();
    },
  };
}
