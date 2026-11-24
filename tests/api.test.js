import test from 'node:test';
import assert from 'node:assert/strict';

import { applicationFixture, PASSWORD } from './support.js';
async function fixture(t, options = {}) {
  const f = await applicationFixture(t, options);
  function client() {
    const raw = f.client();
    return {
      get cookie() {
        return raw.cookie;
      },
      stream: raw.stream,
      request: async (path, method = 'GET', body, headers) => {
        if (path === '/api/auth/register') return f.register(raw, body);
        if (path === '/api/auth/login') path = '/api/identity/sign-in/email';
        if (path === '/api/auth/logout') path = '/api/identity/sign-out';
        if (path === '/api/auth/password') {
          path = '/api/identity/change-password';
          body = { ...body, revokeOtherSessions: true };
        }
        return raw.request(path, method, body, headers);
      },
    };
  }
  const owner = client();
  const registered = await owner.request('/api/auth/register', 'POST', {
    name: 'Maya Torres',
    email: 'maya@example.test',
    password: PASSWORD,
  });
  assert.equal(registered.status, 201);
  const workspace = await owner.request('/api/workspaces', 'POST', {
    name: 'Northstar',
    sample: true,
  });
  const workspaceId = workspace.data.workspace.id;
  const data = (await owner.request(`/api/workspaces/${workspaceId}/data`)).data;
  async function invite(email, role = 'member') {
    const response = await owner.request(`/api/workspaces/${workspaceId}/invitations`, 'POST', {
      email,
      role,
    });
    assert.equal(response.status, 201);
    return response.data.inviteUrl.split('/invite/')[1];
  }
  async function teammate(email = 'jo@example.test', role = 'admin') {
    const inviteToken = await invite(email, role);
    const member = client();
    const response = await member.request('/api/auth/register', 'POST', {
      name: email.split('@')[0],
      email,
      password: PASSWORD,
      inviteToken,
    });
    assert.equal(response.status, 201);
    return { client: member, user: response.data.user, inviteToken };
  }
  return {
    owner,
    workspaceId,
    project: data.projects[0],
    data,
    client,
    invite,
    teammate,
    restart: async () => {
      await f.restart();
    },
  };
}

test('records and sessions survive a server restart; logout revokes the session', async (t) => {
  const f = await fixture(t);
  const created = await f.owner.request(`/api/projects/${f.project.id}/tasks`, 'POST', {
    title: 'Persist this task',
  });
  assert.equal(created.status, 201);
  await f.restart();
  const data = await f.owner.request(`/api/workspaces/${f.workspaceId}/data`);
  assert.equal(data.status, 200);
  assert(data.data.tasks.some((task) => task.title === 'Persist this task'));
  assert.equal((await f.owner.request('/api/auth/me')).data.user.email, 'maya@example.test');
  await f.owner.request('/api/auth/logout', 'POST', {});
  assert.equal((await f.owner.request('/api/workspaces')).status, 401);
  assert.equal(
    (
      await f.owner.request('/api/auth/login', 'POST', {
        email: 'MAYA@example.test',
        password: PASSWORD,
      })
    ).status,
    200,
  );
});

test('registration is invite-only after bootstrap, invitations are email-bound and single-use', async (t) => {
  const f = await fixture(t);
  const stranger = f.client();
  assert.equal(
    (
      await stranger.request('/api/auth/register', 'POST', {
        name: 'Other',
        email: 'other@example.test',
        password: PASSWORD,
      })
    ).status,
    403,
  );
  const inviteToken = await f.invite('jo@example.test');
  assert.equal(
    (
      await stranger.request('/api/auth/register', 'POST', {
        name: 'Other',
        email: 'other@example.test',
        password: PASSWORD,
        inviteToken,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await stranger.request('/api/auth/register', 'POST', {
        name: 'Jo',
        email: 'jo@example.test',
        password: PASSWORD,
        inviteToken,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await f.client().request('/api/auth/register', 'POST', {
        name: 'Replay',
        email: 'replay@example.test',
        password: PASSWORD,
        inviteToken,
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.owner.request(`/api/workspaces/${f.workspaceId}/invitations`)).data.invitations[0]
      .tokenHash,
    undefined,
  );
});

test('viewer permissions are enforced by the server, including direct write requests', async (t) => {
  const f = await fixture(t);
  const viewer = await f.teammate('viewer@example.test', 'viewer');
  const c = viewer.client;
  assert.equal((await c.request(`/api/workspaces/${f.workspaceId}/data`)).status, 200);
  assert.equal(
    (await c.request(`/api/projects/${f.project.id}/tasks`, 'POST', { title: 'Forbidden' })).status,
    403,
  );
  const doc = f.data.documents[0];
  assert.equal(
    (
      await c.request(`/api/documents/${doc.id}`, 'PATCH', {
        version: doc.version,
        body: 'Forbidden',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await c.request(`/api/workspaces/${f.workspaceId}/invitations`, 'POST', {
        email: 'x@example.test',
      })
    ).status,
    403,
  );
  assert.equal((await c.request(`/api/workspaces/${f.workspaceId}/export`)).status, 403);
});

test('workspace isolation applies to reads, updates, comments, assignees and event streams', async (t) => {
  const f = await fixture(t);
  const other = await f.teammate();
  const workspace = (
    await other.client.request('/api/workspaces', 'POST', { name: 'Separate', sample: true })
  ).data.workspace;
  const data = (await other.client.request(`/api/workspaces/${workspace.id}/data`)).data;
  assert.equal((await f.owner.request(`/api/workspaces/${workspace.id}/data`)).status, 404);
  assert.equal(
    (
      await f.owner.request(`/api/tasks/${data.tasks[0].id}`, 'PATCH', {
        version: 1,
        title: 'Cross-workspace write',
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.owner.request(`/api/workspaces/${f.workspaceId}/comments`, 'POST', {
        entityType: 'task',
        entityId: data.tasks[0].id,
        body: 'Cross-workspace comment',
      })
    ).status,
    404,
  );
  assert.equal((await f.owner.stream(workspace.id)).status, 404);
  assert.equal(
    (
      await other.client.request(`/api/projects/${data.projects[0].id}/tasks`, 'POST', {
        title: 'Bad assignee',
        assigneeId: f.data.members[0].id,
      })
    ).status,
    400,
  );
});

test('approval reserves cents once; payment moves reserved to spent without reducing available again', async (t) => {
  const f = await fixture(t);
  const jo = await f.teammate();
  const ownerId = f.data.members[0].id;
  const response = await jo.client.request('/api/requests', 'POST', {
    projectId: f.project.id,
    title: 'Illustrations',
    reason: 'Three scenes',
    amountCents: 60000,
    category: 'Design',
    approverId: ownerId,
  });
  assert.equal(response.status, 201);
  const request = response.data.request;
  assert.equal(
    (
      await jo.client.request(`/api/requests/${request.id}/action`, 'POST', {
        action: 'approve',
        version: 1,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.owner.request(`/api/requests/${request.id}/action`, 'POST', {
        action: 'approve',
        version: 1,
      })
    ).status,
    200,
  );
  const afterApproval = (await f.owner.request(`/api/workspaces/${f.workspaceId}/data`)).data
    .projects[0].budget;
  assert.deepEqual(afterApproval, {
    allocated: 500000,
    spent: 120000,
    reserved: 60000,
    available: 320000,
  });
  assert.equal(
    (
      await f.owner.request(`/api/requests/${request.id}/action`, 'POST', {
        action: 'approve',
        version: 1,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.owner.request(`/api/requests/${request.id}/action`, 'POST', {
        action: 'pay',
        version: 2,
      })
    ).status,
    200,
  );
  const final = (await f.owner.request(`/api/workspaces/${f.workspaceId}/data`)).data;
  assert.deepEqual(final.projects[0].budget, {
    allocated: 500000,
    spent: 180000,
    reserved: 0,
    available: 320000,
  });
  assert.equal(final.expenses.filter((expense) => expense.requestId === request.id).length, 1);
  assert.equal(
    (
      await f.owner.request(`/api/requests/${request.id}/action`, 'POST', {
        action: 'pay',
        version: 3,
      })
    ).status,
    409,
  );
  const own = await f.owner.request('/api/requests', 'POST', {
    projectId: f.project.id,
    title: 'Own request',
    reason: 'Test',
    amountCents: 100,
    category: 'Other',
    approverId: ownerId,
  });
  assert.equal(own.status, 400);
});

test('concurrent approvals cannot overcommit a budget; stale document writes retain the latest content', async (t) => {
  const f = await fixture(t);
  const jo = await f.teammate();
  const project = (
    await f.owner.request(`/api/workspaces/${f.workspaceId}/projects`, 'POST', {
      name: 'Atomic budget',
      budgetCents: 100000,
    })
  ).data.project;
  const requests = [];
  for (let i = 0; i < 2; i++)
    requests.push(
      (
        await jo.client.request('/api/requests', 'POST', {
          projectId: project.id,
          title: `Commitment ${i}`,
          reason: 'Atomic check',
          amountCents: 80000,
          category: 'Other',
          approverId: f.data.members[0].id,
        })
      ).data.request,
    );
  const results = await Promise.all(
    requests.map((request) =>
      f.owner.request(`/api/requests/${request.id}/action`, 'POST', {
        action: 'approve',
        version: 1,
      }),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const data = (await f.owner.request(`/api/workspaces/${f.workspaceId}/data`)).data;
  assert.equal(data.projects.find((p) => p.id === project.id).budget.available, 20000);
  const doc = f.data.documents[0];
  assert.equal(
    (
      await f.owner.request(`/api/documents/${doc.id}`, 'PATCH', {
        version: 1,
        body: 'Latest team version',
      })
    ).status,
    200,
  );
  const conflict = await jo.client.request(`/api/documents/${doc.id}`, 'PATCH', {
    version: 1,
    body: 'Stale draft',
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.current.body, 'Latest team version');
  assert.equal(
    (await jo.client.request(`/api/workspaces/${f.workspaceId}/data`)).data.documents[0].body,
    'Latest team version',
  );
});

test('declines require a reason and manual expenses can be voided with an audit trail', async (t) => {
  const f = await fixture(t);
  const jo = await f.teammate();
  const request = (
    await jo.client.request('/api/requests', 'POST', {
      projectId: f.project.id,
      title: 'Tool',
      reason: 'Testing',
      amountCents: 14950,
      category: 'Software',
      approverId: f.data.members[0].id,
    })
  ).data.request;
  assert.equal(
    (
      await f.owner.request(`/api/requests/${request.id}/action`, 'POST', {
        action: 'decline',
        version: 1,
      })
    ).status,
    400,
  );
  const declined = await f.owner.request(`/api/requests/${request.id}/action`, 'POST', {
    action: 'decline',
    version: 1,
    reason: 'Use our existing tool.',
  });
  assert.equal(declined.data.request.declineReason, 'Use our existing tool.');
  const expense = (
    await f.owner.request('/api/expenses', 'POST', {
      projectId: f.project.id,
      title: 'Software',
      amountCents: 14950,
      category: 'Software',
      paidOn: '2026-11-20',
    })
  ).data.expense;
  assert.equal(
    (await f.owner.request(`/api/workspaces/${f.workspaceId}/data`)).data.projects[0].budget.spent,
    134950,
  );
  assert.equal(
    (
      await f.owner.request(`/api/expenses/${expense.id}/void`, 'POST', {
        reason: 'Duplicate entry',
      })
    ).status,
    200,
  );
  const data = (await f.owner.request(`/api/workspaces/${f.workspaceId}/data`)).data;
  assert.equal(data.projects[0].budget.spent, 120000);
  assert(data.activity.some((a) => a.action === 'voided'));
});

test('workspace events reach another member; removing that member revokes reads and streams', async (t) => {
  const f = await fixture(t);
  const jo = await f.teammate();
  const stream = await jo.client.stream(f.workspaceId);
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const ready = await reader.read();
  assert.match(new TextDecoder().decode(ready.value), /event: ready/);
  await f.owner.request(`/api/projects/${f.project.id}/tasks`, 'POST', { title: 'Shared update' });
  const update = await reader.read();
  assert.match(new TextDecoder().decode(update.value), /event: update/);
  await f.owner.request(`/api/workspaces/${f.workspaceId}/members/${jo.user.id}`, 'DELETE', {});
  assert.equal((await jo.client.request(`/api/workspaces/${f.workspaceId}/data`)).status, 404);
  assert.equal((await reader.read()).done, true);
});

test('unsafe cross-origin requests fail; exports omit authentication secrets; the last owner is protected', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.owner.request(
        `/api/projects/${f.project.id}/tasks`,
        'POST',
        { title: 'CSRF' },
        { Origin: 'https://example.invalid' },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.owner.request(
        `/api/workspaces/${f.workspaceId}/members/${f.data.members[0].id}`,
        'PATCH',
        { role: 'member' },
      )
    ).status,
    409,
  );
  const exported = await f.owner.request(`/api/workspaces/${f.workspaceId}/export`);
  assert.equal(exported.status, 200);
  assert.equal(exported.data.format, 'orluma-export');
  assert.doesNotMatch(
    JSON.stringify(exported.data),
    /password_hash|passwordHash|token_hash|tokenHash|orluma_session/,
  );
  assert.equal(
    (
      await f.owner.request(`/api/projects/${f.project.id}/tasks`, 'POST', {
        title: 'Bad money',
        assigneeId: 'not-a-user',
      })
    ).status,
    400,
  );
});

test('password changes invalidate other sessions and retain a working current session', async (t) => {
  const f = await fixture(t);
  const second = f.client();
  await second.request('/api/auth/login', 'POST', {
    email: 'maya@example.test',
    password: PASSWORD,
  });
  assert.equal(
    (
      await f.owner.request('/api/auth/password', 'POST', {
        currentPassword: PASSWORD,
        newPassword: 'a-new-long-test-password-2026',
      })
    ).status,
    200,
  );
  assert.equal((await second.request('/api/workspaces')).status, 401);
  assert.equal((await f.owner.request('/api/workspaces')).status, 200);
  assert.equal(
    (
      await second.request('/api/auth/login', 'POST', {
        email: 'maya@example.test',
        password: PASSWORD,
      })
    ).status,
    401,
  );
});

test('pending approvers cannot be demoted; viewers cannot receive work; overspent projects remain editable', async (t) => {
  const f = await fixture(t);
  const jo = await f.teammate();
  const viewer = await f.teammate('read-only@example.test', 'viewer');
  assert.equal(
    (
      await f.owner.request(`/api/projects/${f.project.id}/tasks`, 'POST', {
        title: 'Do not assign to a viewer',
        assigneeId: viewer.user.id,
      })
    ).status,
    400,
  );
  await f.owner.request('/api/requests', 'POST', {
    projectId: f.project.id,
    title: 'Pending decision',
    reason: 'Keep assigned approver available',
    amountCents: 100,
    category: 'Other',
    approverId: jo.user.id,
  });
  assert.equal(
    (
      await f.owner.request(`/api/workspaces/${f.workspaceId}/members/${jo.user.id}`, 'PATCH', {
        role: 'member',
      })
    ).status,
    409,
  );
  await f.owner.request('/api/expenses', 'POST', {
    projectId: f.project.id,
    title: 'Actual overspend',
    amountCents: 500000,
    category: 'Other',
    paidOn: '2026-11-20',
  });
  const edited = await f.owner.request(`/api/projects/${f.project.id}`, 'PATCH', {
    version: 1,
    name: 'Updated context',
  });
  assert.equal(edited.status, 200);
  assert.equal(
    (
      await f.owner.request(`/api/projects/${f.project.id}`, 'PATCH', {
        version: 2,
        budgetCents: 400000,
      })
    ).status,
    409,
  );
});

test('partial updates preserve task context, document text and project budget settings', async (t) => {
  const f = await fixture(t);
  const created = (
    await f.owner.request(`/api/projects/${f.project.id}/tasks`, 'POST', {
      title: 'Keep the context',
      description: 'Detailed work instructions',
      assigneeId: f.data.members[0].id,
      dueDate: '2026-12-01',
    })
  ).data.task;
  const updated = (
    await f.owner.request(`/api/tasks/${created.id}`, 'PATCH', {
      version: created.version,
      status: 'done',
    })
  ).data.task;
  assert.equal(updated.description, created.description);
  assert.equal(updated.assigneeId, created.assigneeId);
  assert.equal(updated.dueDate, created.dueDate);
  const document = f.data.documents[0];
  const renamed = (
    await f.owner.request(`/api/documents/${document.id}`, 'PATCH', {
      version: document.version,
      title: 'Renamed brief',
    })
  ).data.document;
  assert.equal(renamed.body, document.body);
  const project = (
    await f.owner.request(`/api/projects/${f.project.id}`, 'PATCH', {
      version: 1,
      name: 'Renamed project',
    })
  ).data.project;
  assert.equal(project.budgetCents, f.project.budgetCents);
  assert.equal(project.goal, f.project.goal);
  const result = (await f.owner.request(`/api/workspaces/${f.workspaceId}/data`)).data;
  assert.equal(result.allocations.length, f.data.allocations.length);
});
