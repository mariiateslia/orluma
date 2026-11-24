import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationFixture, PASSWORD, ORIGIN } from './support.js';

const signUp = (c, email) =>
  c.request('/api/identity/sign-up/email', 'POST', {
    email,
    name: 'Test person',
    password: PASSWORD,
    callbackURL: ORIGIN + '/?verified=1',
  });
const signIn = (c, email, password = PASSWORD) =>
  c.request('/api/identity/sign-in/email', 'POST', { email, password });

test('registration requires a delivered email confirmation; recovery is one-use and revokes every session', async (t) => {
  const f = await applicationFixture(t, { registrationMode: 'open' }),
    person = f.client(),
    other = f.client();
  assert.equal((await signUp(person, 'person@example.test')).status, 200);
  assert.equal((await person.request('/api/workspaces')).status, 401);
  const denied = await signIn(person, 'person@example.test');
  assert.equal(denied.status, 403);
  assert.equal(denied.data.code, 'EMAIL_NOT_VERIFIED');
  const queue = await f.runtime.db.prepare('SELECT payload FROM mail_outbox').get();
  assert(queue.payload);
  assert(!queue.payload.includes('person@example.test'));
  assert(!queue.payload.includes('token='));
  assert.equal((await f.verify('person@example.test', person)).status, 302);
  const logged = await signIn(person, 'person@example.test');
  assert.equal(logged.status, 200);
  assert.match(logged.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(logged.headers.get('set-cookie'), /SameSite=Lax/i);
  assert.equal((await signIn(other, 'person@example.test')).status, 200);
  const known = await person.request('/api/identity/request-password-reset', 'POST', {
    email: 'person@example.test',
    redirectTo: ORIGIN + '/reset-password',
  });
  const unknown = await person.request('/api/identity/request-password-reset', 'POST', {
    email: 'unknown@example.test',
    redirectTo: ORIGIN + '/reset-password',
  });
  assert.equal(known.status, 200);
  assert.deepEqual(known.data, unknown.data);
  await f.runtime.mail.flush();
  const message = f.messages.find((m) => m.subject.includes('Reset'));
  const link = new URL(message.text.match(/https?:\/\/\S+/)[0]);
  const redirect = await person.request(link.pathname + link.search);
  assert.equal(redirect.status, 302);
  const callback = new URL(redirect.headers.get('location'));
  assert.equal(callback.pathname, '/reset-password');
  const token = callback.searchParams.get('token');
  assert(token);
  const newPassword = 'new-recovery-passphrase-2026';
  assert.equal(
    (await person.request('/api/identity/reset-password', 'POST', { token, newPassword })).status,
    200,
  );
  assert.equal((await person.request('/api/workspaces')).status, 401);
  assert.equal((await other.request('/api/workspaces')).status, 401);
  assert.equal(
    (await person.request('/api/identity/reset-password', 'POST', { token, newPassword })).status,
    400,
  );
  assert.equal((await signIn(other, 'person@example.test')).status, 401);
  assert.equal((await signIn(other, 'person@example.test', newPassword)).status, 200);
  const pending = await f.runtime.db
    .prepare(
      "SELECT COUNT(*) AS count FROM mail_outbox WHERE status='sent' AND payload IS NOT NULL",
    )
    .get();
  assert.equal(pending.count, 0);
});

test('expired recovery links and untrusted callbacks cannot replace a password', async (t) => {
  const f = await applicationFixture(t),
    c = f.client();
  await f.register(c, { email: 'owner@example.test' });
  await c.request('/api/identity/request-password-reset', 'POST', {
    email: 'owner@example.test',
    redirectTo: ORIGIN + '/reset-password',
  });
  await f.runtime.mail.flush();
  const link = new URL(
    f.messages.find((m) => m.subject.includes('Reset')).text.match(/https?:\/\/\S+/)[0],
  );
  await f.runtime.db.exec(
    "UPDATE auth_verifications SET expires_at=now()-interval '1 second' WHERE identifier LIKE 'reset-password:%'",
  );
  const result = await c.request(link.pathname + link.search);
  assert.match(result.headers.get('location'), /INVALID_TOKEN/);
  const bad = await c.request('/api/identity/request-password-reset', 'POST', {
    email: 'owner@example.test',
    redirectTo: 'https://evil.example/reset',
  });
  assert(bad.status >= 400);
  assert.equal((await signIn(c, 'owner@example.test')).status, 200);
});

test('financial reads, direct mutations, comments, exports and demotions honor the role matrix', async (t) => {
  const f = await applicationFixture(t),
    owner = f.client();
  const ownerUser = (await f.register(owner, { email: 'owner@example.test' })).data.user;
  const workspace = (
    await owner.request('/api/workspaces', 'POST', { name: 'Financial isolation', sample: true })
  ).data.workspace;
  const root = `/api/workspaces/${workspace.id}`;
  async function teammate(email, role) {
    const invitation = await owner.request(root + '/invitations', 'POST', { email, role });
    const c = f.client();
    const user = (
      await f.register(c, { email, inviteToken: invitation.data.inviteUrl.split('/invite/')[1] })
    ).data.user;
    return { c, user };
  }
  const member = await teammate('member@example.test', 'member'),
    second = await teammate('second@example.test', 'member'),
    viewer = await teammate('viewer@example.test', 'viewer');
  const project = (await owner.request(root + '/data')).data.projects[0];
  async function request(c, title) {
    return (
      await c.request('/api/requests', 'POST', {
        projectId: project.id,
        title,
        reason: 'Needed for project work',
        amountCents: 10000,
        category: 'Software',
        approverId: ownerUser.id,
      })
    ).data.request;
  }
  const mine = await request(member.c, 'Member private request'),
    theirs = await request(second.c, 'Other private request');
  assert(mine?.id && theirs?.id);
  await second.c.request(root + '/comments', 'POST', {
    entityType: 'request',
    entityId: theirs.id,
    body: 'Financial context for second member',
  });
  const snapshot = (await member.c.request(root + '/data')).data;
  assert.equal(snapshot.projects[0].budget, null);
  assert.equal(snapshot.projects[0].budgetCents, null);
  assert.deepEqual(snapshot.allocations, []);
  assert.deepEqual(
    snapshot.requests.map((r) => r.id),
    [mine.id],
  );
  assert.equal(snapshot.expenses.length, 0);
  assert(!JSON.stringify(snapshot).includes('Other private request'));
  assert(!JSON.stringify(snapshot).includes('Financial context for second member'));
  assert.equal(
    (
      await member.c.request(`/api/requests/${theirs.id}/action`, 'POST', {
        action: 'cancel',
        version: 1,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await member.c.request(root + '/comments', 'POST', {
        entityType: 'request',
        entityId: theirs.id,
        body: 'Attempt unauthorized read/write',
      })
    ).status,
    403,
  );
  assert.equal((await member.c.request(root + '/export')).status, 403);
  const metadata = await member.c.request('/api/projects/' + project.id, 'PATCH', {
    version: 1,
    description: 'Shared team context',
  });
  assert.equal(metadata.status, 200);
  assert.equal(metadata.data.project.budgetCents, null);
  assert.equal(metadata.data.project.budget, null);
  const view = (await viewer.c.request(root + '/data')).data;
  assert.equal(view.requests.length, 0);
  assert.equal(view.expenses.length, 0);
  assert.equal(view.projects[0].budget, null);
  assert.equal(
    (
      await viewer.c.request(root + '/comments', 'POST', {
        entityType: 'request',
        entityId: mine.id,
        body: 'No access',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await owner.request(`/api/requests/${mine.id}/action`, 'POST', {
        action: 'approve',
        version: 1,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await member.c.request(`/api/requests/${mine.id}/action`, 'POST', {
        action: 'pay',
        version: 2,
      })
    ).status,
    200,
  );
  assert.equal((await member.c.request(root + '/data')).data.expenses.length, 1);
  assert.equal((await second.c.request(root + '/data')).data.expenses.length, 0);
  await owner.request(root + '/members/' + member.user.id, 'PATCH', { role: 'viewer' });
  const demoted = (await member.c.request(root + '/data')).data;
  assert.equal(demoted.requests.length, 0);
  assert.equal(demoted.expenses.length, 0);
  assert.equal(
    (
      await member.c.request(`/api/requests/${mine.id}/action`, 'POST', {
        action: 'cancel',
        version: 3,
      })
    ).status,
    403,
  );
});

test('email queue retries without storing plaintext or sending before commit', async (t) => {
  let attempts = 0;
  const delivered = [];
  const f = await applicationFixture(t, {
    mailTransport: async (m) => {
      attempts++;
      if (attempts === 1) throw new Error('simulated outage');
      delivered.push(m);
    },
  });
  const c = f.client();
  await signUp(c, 'retry@example.test');
  await f.runtime.mail.flush();
  const pending = await f.runtime.db.prepare('SELECT * FROM mail_outbox').get();
  assert.equal(pending.status, 'queued');
  assert.equal(pending.attempts, 1);
  assert(pending.payload);
  await f.runtime.db.exec("UPDATE mail_outbox SET available_at=now()-interval '1 second'");
  await f.runtime.mail.flush();
  assert.equal(delivered.length, 1);
  assert.equal((await f.runtime.db.prepare('SELECT payload FROM mail_outbox').get()).payload, null);
});

test('public bootstrap is reserved for the configured initial email', async (t) => {
  const f = await applicationFixture(t, { bootstrapEmail: 'owner@example.test' }),
    c = f.client();
  assert.equal((await signUp(c, 'stranger@example.test')).status, 403);
  assert.equal((await signUp(c, 'owner@example.test')).status, 200);
  assert.equal((await signUp(c, 'second@example.test')).status, 403);
});
