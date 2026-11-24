import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const [phase, path] = process.argv.slice(2),
  origin = 'http://localhost:3000';
async function request(endpoint, method = 'GET', body, cookie = '') {
  const response = await fetch(origin + endpoint, {
    method,
    redirect: 'manual',
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert(response.status < 400, `${endpoint} returned ${response.status}`);
  return {
    data: await response.json().catch(() => ({})),
    cookie: response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
  };
}
if (phase === 'seed') {
  const email = 'container@example.test',
    password = 'synthetic-container-test-passphrase';
  await request('/api/identity/sign-up/email', 'POST', {
    name: 'Container test',
    email,
    password,
    callbackURL: origin + '/?verified=1',
  });
  let messageId;
  for (let i = 0; i < 50; i++) {
    const inbox = await (await fetch('http://localhost:8025/api/v1/messages')).json();
    messageId = inbox.messages?.find((m) => m.Subject === 'Confirm your Orluma email')?.ID;
    if (messageId) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert(messageId, 'SMTP confirmation did not arrive in Mailpit.');
  const message = await (await fetch('http://localhost:8025/api/v1/message/' + messageId)).json();
  const url = new URL(message.Text.match(/https?:\/\/\S+/)[0]);
  await request(url.pathname + url.search);
  const auth = await request('/api/identity/sign-in/email', 'POST', { email, password });
  const workspace = await request(
    '/api/workspaces',
    'POST',
    { name: 'Container persistence', sample: true },
    auth.cookie,
  );
  writeFileSync(path, JSON.stringify({ cookie: auth.cookie, id: workspace.data.workspace.id }), {
    mode: 0o600,
  });
  console.log('Created verified synthetic account and workspace through SMTP and PostgreSQL.');
} else if (phase === 'verify') {
  const state = JSON.parse(readFileSync(path, 'utf8'));
  const result = await request(`/api/workspaces/${state.id}/data`, 'GET', undefined, state.cookie);
  assert.equal(result.data.workspace.name, 'Container persistence');
  assert.equal(result.data.tasks.length, 6);
  assert.equal(result.data.projects[0].budget.available, 380000);
  console.log('Verified account, session and workspace survived container restart.');
} else throw new Error('Use seed or verify and a temporary state path.');
