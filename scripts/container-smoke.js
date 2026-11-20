import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

// CI-only synthetic account, persisted between two runner invocations.
const [phase, path] = process.argv.slice(2);
const origin = 'http://localhost:3000';
async function request(endpoint, method = 'GET', body, cookie = '') {
  const response = await fetch(origin + endpoint, {
    method,
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert(response.ok, `${endpoint} returned ${response.status}`);
  return { data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
if (phase === 'seed') {
  const auth = await request('/api/auth/register', 'POST', {
    name: 'Container test',
    email: 'container@example.test',
    password: 'synthetic-container-test-passphrase',
  });
  const workspace = await request(
    '/api/workspaces',
    'POST',
    { name: 'Container persistence', sample: true },
    auth.cookie,
  );
  writeFileSync(path, JSON.stringify({ cookie: auth.cookie, id: workspace.data.workspace.id }), {
    mode: 0o600,
  });
  console.log('Created synthetic workspace in container volume.');
} else if (phase === 'verify') {
  const state = JSON.parse(readFileSync(path, 'utf8'));
  const result = await request(`/api/workspaces/${state.id}/data`, 'GET', undefined, state.cookie);
  assert.equal(result.data.workspace.name, 'Container persistence');
  assert.equal(result.data.tasks.length, 6);
  assert.equal(result.data.projects[0].budget.available, 380000);
  console.log('Session and workspace survived container restart.');
} else throw new Error('Use seed or verify and a temporary state path.');
