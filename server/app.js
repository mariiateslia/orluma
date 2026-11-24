import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import {
  openDatabase,
  transaction,
  id,
  now,
  camel,
  rows,
  audit,
  projectBudget,
  seedSampleProject,
} from './database.js';
import { HttpError, assert, token, digest, member, scoped, expectVersion } from './security.js';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { createIdentity } from './auth.js';
import { createMail } from './mail.js';
import * as schema from './validation.js';
const EDITORS = ['owner', 'admin', 'member'];
const ADMINS = ['owner', 'admin'];
const safeUser = (user) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  createdAt: user.created_at instanceof Date ? user.created_at.toISOString() : user.created_at,
});
const one = async (db, table, rowId) =>
  camel(await db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(rowId));
export async function createApplication(options = {}) {
  const db =
    options.db ||
    (await openDatabase(options.databaseUrl || process.env.DATABASE_URL, {
      schema: options.databaseSchema,
    }));
  const appUrl = new URL(options.appUrl || process.env.APP_URL || 'http://localhost:3000');
  const development = options.development ?? process.env.NODE_ENV === 'development';
  const registrationMode = options.registrationMode || process.env.REGISTRATION_MODE || 'invite';
  const bootstrapEmail = options.bootstrapEmail || process.env.BOOTSTRAP_EMAIL || '';
  if (appUrl.protocol === 'https:' && registrationMode === 'invite' && !bootstrapEmail) {
    await db.close();
    throw new Error('Set BOOTSTRAP_EMAIL before publishing an invite-only installation.');
  }
  const secure = appUrl.protocol === 'https:';
  const secret = options.authSecret || process.env.AUTH_SECRET;
  const mail = createMail({
    db,
    secret,
    from: options.mailFrom || process.env.MAIL_FROM,
    transport: options.mailTransport,
  });
  const identity = createIdentity({
    db,
    appUrl: appUrl.origin,
    secret,
    mail,
    registrationMode,
    bootstrapEmail,
    development,
    disableRateLimit: options.disableRateLimit,
  });
  const stopMail = options.disableMailWorker ? () => {} : mail.start();
  const app = express();
  const streams = new Map();
  const allowedOrigins = new Set([appUrl.origin]);
  if (development) {
    allowedOrigins.add('http://localhost:5173');
    allowedOrigins.add('http://127.0.0.1:5173');
  }
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: development
        ? false
        : {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", 'data:'],
              fontSrc: ["'self'"],
              connectSrc: ["'self'"],
              frameAncestors: ["'none'"],
              upgradeInsecureRequests: secure ? [] : null,
            },
          },
      strictTransportSecurity: secure ? undefined : false,
    }),
  );
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', (req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      assert(
        allowedOrigins.has(req.headers.origin),
        403,
        'Open Orluma at its configured URL and try again.',
        'invalid_origin',
      );
      assert(
        req.is('application/json'),
        415,
        'Send JSON with this request.',
        'invalid_content_type',
      );
    }
    next();
  });
  app.all('/api/identity/*splat', toNodeHandler(identity));
  app.use(express.json({ limit: '512kb' }));
  const writeLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: options.disableRateLimit ? 100000 : 180,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: (req) => ['GET', 'HEAD', 'OPTIONS'].includes(req.method),
    message: { error: 'Too many changes. Please wait a minute.', code: 'rate_limited' },
  });
  app.use('/api', writeLimiter);
  async function session(req) {
    const result = await identity.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!result?.user.emailVerified) return null;
    req.sessionId = result.session.id;
    return { ...result.user, created_at: result.user.createdAt };
  }
  async function requireUser(req, res, next) {
    req.user = await session(req);
    assert(req.user, 401, 'Please sign in to continue.', 'unauthorized');
    next();
  }
  async function validStream(entry, workspaceId) {
    return db
      .prepare(
        'SELECT 1 FROM auth_sessions JOIN memberships ON memberships.user_id=auth_sessions.user_id JOIN users ON users.id=auth_sessions.user_id WHERE auth_sessions.id=? AND auth_sessions.expires_at>now() AND memberships.workspace_id=? AND users.email_verified=true',
      )
      .get(entry.sessionId, workspaceId);
  }
  async function notify(workspaceId, kind = 'changed') {
    for (const entry of streams.get(workspaceId) || []) {
      try {
        if (!(await validStream(entry, workspaceId))) {
          entry.res.end();
          continue;
        }
        entry.res.write(`event: update\ndata: ${JSON.stringify({ kind, at: now() })}\n\n`);
      } catch {
        entry.res.end();
      } // A failed notification must not fail a committed write.
    }
  }
  async function changed(workspaceId, req, action, table, rowId, summary, projectId) {
    await audit(db, workspaceId, req.user.id, action, table, rowId, summary, projectId);
  }
  async function projectContext(projectId, userId, roles = EDITORS, allowArchived = false) {
    const project = await db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    assert(project, 404, 'Project not found.', 'not_found');
    const membership = await member(db, project.workspace_id, userId, roles);
    assert(
      allowArchived || !project.archived,
      409,
      'Restore this project before making changes.',
      'archived',
    );
    return { project, membership };
  }
  async function projectResponse(projectId, userId) {
    const project = await one(db, 'projects', projectId);
    const role = (await member(db, project.workspaceId, userId)).role;
    return {
      ...project,
      budgetCents: ADMINS.includes(role) ? project.budgetCents : null,
      budget: ADMINS.includes(role) ? await projectBudget(db, projectId) : null,
    };
  }
  async function validAssignee(workspaceId, assigneeId) {
    if (assigneeId)
      assert(
        await db
          .prepare(
            "SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=? AND role!='viewer'",
          )
          .get(workspaceId, assigneeId),
        400,
        'Choose an assignee from this workspace.',
        'invalid_assignee',
      );
  }
  function validAllocations(allocations, budgetCents) {
    assert(
      new Set(allocations.map((a) => a.name.toLowerCase())).size === allocations.length,
      400,
      'Allocation names must be unique.',
      'invalid_allocations',
    );
    assert(
      allocations.reduce((sum, a) => sum + a.amountCents, 0) <= budgetCents,
      400,
      'Allocations cannot exceed the project budget.',
      'invalid_allocations',
    );
  }
  async function writeAllocations(projectId, allocations) {
    await db.prepare('DELETE FROM allocations WHERE project_id=?').run(projectId);
    for (const allocation of allocations)
      await db
        .prepare('INSERT INTO allocations(id,project_id,name,amount_cents) VALUES(?,?,?,?)')
        .run(id(), projectId, allocation.name, allocation.amountCents);
  }
  async function invitationByToken(rawToken) {
    assert(
      typeof rawToken === 'string' && rawToken.length >= 20 && rawToken.length <= 200,
      400,
      'This invitation is invalid.',
      'invalid_invitation',
    );
    const invitation = await db
      .prepare('SELECT * FROM invitations WHERE token_hash=?')
      .get(digest(rawToken));
    assert(
      invitation &&
        !invitation.used_at &&
        !invitation.revoked_at &&
        invitation.expires_at > Date.now(),
      400,
      'This invitation has expired or has already been used.',
      'invalid_invitation',
    );
    const inviter = await db
      .prepare('SELECT role FROM memberships WHERE workspace_id=? AND user_id=?')
      .get(invitation.workspace_id, invitation.created_by);
    assert(
      inviter && ADMINS.includes(inviter.role),
      400,
      'This invitation is no longer active.',
      'invalid_invitation',
    );
    return invitation;
  }
  app.get('/api/health', async (_req, res) => {
    await db.prepare('SELECT 1').get();
    res.json({ ok: true });
  });
  app.get('/api/meta', async (_req, res) => {
    const first =
      Number((await db.prepare('SELECT COUNT(*) AS count FROM users').get()).count) === 0;
    res.json({ registrationOpen: registrationMode === 'open' || first, firstAccount: first });
  });
  app.get('/api/auth/me', async (req, res) => {
    const user = await session(req, res);
    res.json({ user: user ? safeUser(user) : null });
  });
  app.get('/api/invitations/:token', async (req, res) => {
    const invitation = await invitationByToken(req.params.token);
    const workspace = await db
      .prepare('SELECT name FROM workspaces WHERE id=?')
      .get(invitation.workspace_id);
    res.json({
      workspaceName: workspace.name,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expires_at,
    });
  });
  app.post('/api/invitations/accept', requireUser, async (req, res) => {
    const input = z.object({ token: z.string().max(200) }).parse(req.body);
    const workspaceId = await transaction(db, async () => {
      const invitation = await invitationByToken(input.token);
      assert(
        invitation.email.toLowerCase() === req.user.email.toLowerCase(),
        403,
        'Sign in with the invited email address.',
        'invitation_email_mismatch',
      );
      await db
        .prepare(
          'INSERT INTO memberships(workspace_id,user_id,role,joined_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',
        )
        .run(invitation.workspace_id, req.user.id, invitation.role, now());
      await db
        .prepare('UPDATE invitations SET used_at=?,used_by=? WHERE id=?')
        .run(now(), req.user.id, invitation.id);
      await changed(
        invitation.workspace_id,
        req,
        'joined',
        'member',
        req.user.id,
        `${req.user.name} joined the workspace`,
      );
      return invitation.workspace_id;
    });
    await notify(workspaceId, 'member_joined');
    res.json({ workspaceId });
  });
  app.use('/api', requireUser);
  app.get('/api/workspaces', async (req, res) =>
    res.json({
      workspaces: rows(
        await db
          .prepare(
            'SELECT workspaces.*, memberships.role FROM workspaces JOIN memberships ON memberships.workspace_id=workspaces.id WHERE memberships.user_id=? ORDER BY workspaces.created_at',
          )
          .all(req.user.id),
      ),
    }),
  );
  app.post('/api/workspaces', async (req, res) => {
    const input = schema.workspaceInput.parse(req.body);
    const workspaceId = id();
    await transaction(db, async () => {
      await db
        .prepare(
          'INSERT INTO workspaces(id,name,is_sample,created_by,created_at) VALUES(?,?,?,?,?)',
        )
        .run(workspaceId, input.name, input.sample ? 1 : 0, req.user.id, now());
      await db
        .prepare('INSERT INTO memberships(workspace_id,user_id,role,joined_at) VALUES(?,?,?,?)')
        .run(workspaceId, req.user.id, 'owner', now());
      if (input.sample) await seedSampleProject(db, workspaceId, req.user.id);
      await changed(workspaceId, req, 'created', 'workspace', workspaceId, 'Created the workspace');
    });
    res
      .status(201)
      .json({ workspace: { ...(await one(db, 'workspaces', workspaceId)), role: 'owner' } });
  });
  app.get('/api/workspaces/:workspaceId/data', async (req, res) => {
    const workspaceId = req.params.workspaceId;
    const membership = await member(db, workspaceId, req.user.id);
    const finance = ADMINS.includes(membership.role);
    const ownFinance = membership.role === 'member';
    const projects = await Promise.all(
      rows(
        await db
          .prepare('SELECT * FROM projects WHERE workspace_id=? ORDER BY created_at DESC')
          .all(workspaceId),
      ).map(async (project) => ({
        ...project,
        budgetCents: finance ? project.budgetCents : null,
        budget: finance ? await projectBudget(db, project.id) : null,
      })),
    );
    const requests = finance
      ? rows(
          await db
            .prepare('SELECT * FROM spend_requests WHERE workspace_id=? ORDER BY created_at DESC')
            .all(workspaceId),
        )
      : ownFinance
        ? rows(
            await db
              .prepare(
                'SELECT * FROM spend_requests WHERE workspace_id=? AND requester_id=? ORDER BY created_at DESC',
              )
              .all(workspaceId, req.user.id),
          )
        : [];
    const expenses = finance
      ? rows(
          await db
            .prepare(
              'SELECT * FROM expenses WHERE workspace_id=? ORDER BY paid_on DESC,created_at DESC',
            )
            .all(workspaceId),
        )
      : ownFinance
        ? rows(
            await db
              .prepare(
                'SELECT expenses.* FROM expenses JOIN spend_requests ON spend_requests.id=expenses.request_id WHERE expenses.workspace_id=? AND spend_requests.requester_id=? ORDER BY expenses.paid_on DESC',
              )
              .all(workspaceId, req.user.id),
          )
        : [];
    const requestIds = new Set(requests.map((r) => r.id));
    const comments = rows(
      await db
        .prepare('SELECT * FROM comments WHERE workspace_id=? ORDER BY created_at')
        .all(workspaceId),
    ).filter((c) => c.entityType !== 'request' || requestIds.has(c.entityId));
    // Filter BEFORE LIMIT so hidden financial events cannot crowd out work activity.
    const activity = rows(
      await db
        .prepare(
          `SELECT activity.*,users.name AS actor_name FROM activity JOIN users ON users.id=activity.actor_id WHERE workspace_id=? ${finance ? '' : "AND entity_type NOT IN ('request','expense','allocation')"} ORDER BY created_at DESC LIMIT 100`,
        )
        .all(workspaceId),
    );
    res.json({
      workspace: { ...(await one(db, 'workspaces', workspaceId)), role: membership.role },
      permissions: {
        viewFinance: finance,
        manageFinance: finance,
        requestSpending: EDITORS.includes(membership.role),
      },
      projects,
      requests,
      expenses,
      comments,
      activity,
      members: rows(
        await db
          .prepare(
            'SELECT users.id,users.name,users.email,memberships.role,memberships.joined_at FROM memberships JOIN users ON users.id=memberships.user_id WHERE workspace_id=? ORDER BY memberships.joined_at',
          )
          .all(workspaceId),
      ),
      tasks: rows(
        await db
          .prepare('SELECT * FROM tasks WHERE workspace_id=? AND archived=0 ORDER BY created_at')
          .all(workspaceId),
      ),
      documents: rows(
        await db
          .prepare('SELECT * FROM documents WHERE workspace_id=? ORDER BY updated_at DESC')
          .all(workspaceId),
      ),
      allocations: finance
        ? rows(
            await db
              .prepare(
                'SELECT allocations.* FROM allocations JOIN projects ON projects.id=allocations.project_id WHERE projects.workspace_id=?',
              )
              .all(workspaceId),
          )
        : [],
    });
  });
  app.get('/api/workspaces/:workspaceId/events', async (req, res) => {
    const workspaceId = req.params.workspaceId;
    await member(db, workspaceId, req.user.id);
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\nevent: ready\ndata: {}\n\n');
    const entry = { res, userId: req.user.id, sessionId: req.sessionId };
    if (!streams.has(workspaceId)) streams.set(workspaceId, new Set());
    streams.get(workspaceId).add(entry);
    const interval = setInterval(async () => {
      try {
        if (!(await validStream(entry, workspaceId))) res.end();
        else res.write(': heartbeat\n\n');
      } catch {
        res.end();
      }
    }, 15000);
    req.on('close', () => {
      clearInterval(interval);
      streams.get(workspaceId)?.delete(entry);
      if (!streams.get(workspaceId)?.size) streams.delete(workspaceId);
    });
  });
  app.get('/api/workspaces/:workspaceId/export', async (req, res) => {
    const workspaceId = req.params.workspaceId;
    await member(db, workspaceId, req.user.id, ADMINS);
    const data = {};
    for (const table of [
      'projects',
      'tasks',
      'documents',
      'spend_requests',
      'expenses',
      'comments',
      'activity',
    ])
      data[table] = rows(
        await db.prepare(`SELECT * FROM ${table} WHERE workspace_id=?`).all(workspaceId),
      );
    data.allocations = rows(
      await db
        .prepare(
          'SELECT allocations.* FROM allocations JOIN projects ON projects.id=allocations.project_id WHERE workspace_id=?',
        )
        .all(workspaceId),
    );
    data.members = rows(
      await db
        .prepare(
          'SELECT users.name,users.email,memberships.role FROM memberships JOIN users ON users.id=memberships.user_id WHERE workspace_id=?',
        )
        .all(workspaceId),
    );
    res.setHeader('Content-Disposition', 'attachment; filename="orluma-workspace.json"');
    res.json({
      format: 'orluma-export',
      version: 1,
      exportedAt: now(),
      workspace: await one(db, 'workspaces', workspaceId),
      data,
    });
  });
  app.get('/api/workspaces/:workspaceId/invitations', async (req, res) => {
    await member(db, req.params.workspaceId, req.user.id, ADMINS);
    res.json({
      invitations: rows(
        await db
          .prepare(
            'SELECT id,email,role,expires_at,used_at,created_at FROM invitations WHERE workspace_id=? ORDER BY created_at DESC',
          )
          .all(req.params.workspaceId),
      ),
    });
  });
  app.post('/api/workspaces/:workspaceId/invitations', async (req, res) => {
    const workspaceId = req.params.workspaceId;
    const input = schema.invitationInput.parse(req.body);
    const rawToken = token();
    const invitationId = id();
    const expires = Date.now() + 7 * 86400000;
    await transaction(db, async () => {
      const actor = await member(db, workspaceId, req.user.id, ADMINS);
      assert(
        actor.role === 'owner' || input.role !== 'admin',
        403,
        'Only an owner can invite an admin.',
        'forbidden',
      );
      assert(
        !(await db
          .prepare(
            'SELECT 1 FROM memberships JOIN users ON users.id=memberships.user_id WHERE workspace_id=? AND users.email=?',
          )
          .get(workspaceId, input.email)),
        409,
        'This person is already a workspace member.',
        'already_member',
      );

      await db
        .prepare('DELETE FROM invitations WHERE workspace_id=? AND email=? AND used_at IS NULL')
        .run(workspaceId, input.email);
      await db
        .prepare(
          'INSERT INTO invitations(id,workspace_id,email,role,token_hash,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          invitationId,
          workspaceId,
          input.email,
          input.role,
          digest(rawToken),
          expires,
          req.user.id,
          now(),
        );
      await changed(
        workspaceId,
        req,
        'invited',
        'member',
        invitationId,
        'Created a team invitation',
      );
      const workspace = await db.prepare('SELECT name FROM workspaces WHERE id=?').get(workspaceId);
      await mail.enqueue({
        to: input.email,
        subject: 'You’re invited to Orluma',
        text: `${req.user.name} invited you to ${workspace.name} as ${input.role}.\n\nJoin the workspace:\n${appUrl.origin}/#/invite/${rawToken}\n\nThis invitation is for ${input.email}, expires in seven days and can be used once. You will need a verified Orluma account with this email.`,
      });
    });
    await notify(workspaceId, 'invitation_created');
    res.status(201).json({
      delivery: 'queued',
      invitation: { id: invitationId, email: input.email, role: input.role, expiresAt: expires },
      inviteUrl: `${appUrl.origin}/#/invite/${rawToken}`,
    });
  });
  app.delete('/api/workspaces/:workspaceId/invitations/:invitationId', async (req, res) => {
    const workspaceId = req.params.workspaceId;
    await member(db, workspaceId, req.user.id, ADMINS);
    await db
      .prepare('DELETE FROM invitations WHERE id=? AND workspace_id=? AND used_at IS NULL')
      .run(req.params.invitationId, workspaceId);
    await notify(workspaceId);
    res.json({ ok: true });
  });
  app.patch('/api/workspaces/:workspaceId/members/:userId', async (req, res) => {
    const workspaceId = req.params.workspaceId;
    const targetId = req.params.userId;
    const { role } = z.object({ role: schema.roles }).parse(req.body);
    await transaction(db, async () => {
      await member(db, workspaceId, req.user.id, ['owner']);
      const target = await member(db, workspaceId, targetId);
      if (target.role === 'owner' && role !== 'owner')
        assert(
          (
            await db
              .prepare(
                "SELECT COUNT(*) AS count FROM memberships WHERE workspace_id=? AND role='owner'",
              )
              .get(workspaceId)
          ).count > 1,
          409,
          'Keep at least one workspace owner.',
          'last_owner',
        );
      if (!ADMINS.includes(role))
        assert(
          !(await db
            .prepare(
              "SELECT 1 FROM spend_requests WHERE workspace_id=? AND approver_id=? AND status='pending' LIMIT 1",
            )
            .get(workspaceId, targetId)),
          409,
          'Resolve this member’s pending approvals before changing their role.',
          'pending_approvals',
        );
      await db
        .prepare('UPDATE memberships SET role=? WHERE workspace_id=? AND user_id=?')
        .run(role, workspaceId, targetId);
      if (!ADMINS.includes(role))
        await db
          .prepare(
            'DELETE FROM invitations WHERE workspace_id=? AND created_by=? AND used_at IS NULL',
          )
          .run(workspaceId, targetId);
      await changed(
        workspaceId,
        req,
        'role_changed',
        'member',
        targetId,
        `Changed a member’s role to ${role}`,
      );
    });
    await notify(workspaceId, 'permissions_changed');
    res.json({ ok: true });
  });
  app.delete('/api/workspaces/:workspaceId/members/:userId', async (req, res) => {
    const workspaceId = req.params.workspaceId;
    const targetId = req.params.userId;
    await transaction(db, async () => {
      const actor = await member(db, workspaceId, req.user.id);
      const target = await member(db, workspaceId, targetId);
      assert(
        targetId === req.user.id || actor.role === 'owner',
        403,
        'Only an owner can remove another member.',
        'forbidden',
      );
      if (target.role === 'owner')
        assert(
          (
            await db
              .prepare(
                "SELECT COUNT(*) AS count FROM memberships WHERE workspace_id=? AND role='owner'",
              )
              .get(workspaceId)
          ).count > 1,
          409,
          'Transfer ownership before leaving.',
          'last_owner',
        );
      assert(
        !(await db
          .prepare(
            "SELECT 1 FROM spend_requests WHERE workspace_id=? AND approver_id=? AND status='pending' LIMIT 1",
          )
          .get(workspaceId, targetId)),
        409,
        'Resolve this member’s pending approvals before removing them.',
        'pending_approvals',
      );
      await db
        .prepare('DELETE FROM memberships WHERE workspace_id=? AND user_id=?')
        .run(workspaceId, targetId);
      await db
        .prepare(
          'DELETE FROM invitations WHERE workspace_id=? AND created_by=? AND used_at IS NULL',
        )
        .run(workspaceId, targetId);
      await db
        .prepare(
          'UPDATE tasks SET assignee_id=NULL,version=version+1,updated_at=? WHERE workspace_id=? AND assignee_id=?',
        )
        .run(now(), workspaceId, targetId);
      await changed(workspaceId, req, 'removed', 'member', targetId, 'Removed a workspace member');
    });
    await notify(workspaceId, 'member_removed');
    res.json({ ok: true });
  });
  app.post('/api/workspaces/:workspaceId/projects', async (req, res) => {
    const workspaceId = req.params.workspaceId;
    const input = schema.projectFields.parse(req.body);
    validAllocations(input.allocations, input.budgetCents);
    const projectId = id();
    const timestamp = now();
    await transaction(db, async () => {
      await member(db, workspaceId, req.user.id, ADMINS);
      await db
        .prepare(
          'INSERT INTO projects(id,workspace_id,name,description,goal,status,currency,budget_cents,due_date,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          projectId,
          workspaceId,
          input.name,
          input.description,
          input.goal,
          input.status,
          input.currency,
          input.budgetCents,
          input.dueDate,
          req.user.id,
          timestamp,
          timestamp,
        );
      await writeAllocations(projectId, input.allocations);
      await changed(
        workspaceId,
        req,
        'created',
        'project',
        projectId,
        `Created ${input.name}`,
        projectId,
      );
    });
    await notify(workspaceId);
    res.status(201).json({ project: await projectResponse(projectId, req.user.id) });
  });
  app.patch('/api/projects/:projectId', async (req, res) => {
    const input = schema.projectUpdate.parse(req.body);
    const projectId = req.params.projectId;
    let workspaceId;
    await transaction(db, async () => {
      const { project, membership } = await projectContext(projectId, req.user.id, EDITORS, true);
      workspaceId = project.workspace_id;
      expectVersion(project, input.version);
      if (
        input.budgetCents !== undefined ||
        input.currency !== undefined ||
        input.allocations !== undefined ||
        input.archived !== undefined
      )
        assert(
          ADMINS.includes(membership.role),
          403,
          'Only an admin can change budgets or archive projects.',
          'forbidden',
        );
      const allocated = input.budgetCents ?? project.budget_cents;
      const current = await projectBudget(db, projectId);
      if (input.budgetCents !== undefined && allocated !== project.budget_cents)
        assert(
          allocated >= current.spent + current.reserved,
          409,
          'The budget cannot be lower than recorded spending and approved commitments.',
          'budget_in_use',
        );
      if (input.currency && input.currency !== project.currency)
        assert(
          !(await db
            .prepare(
              'SELECT 1 FROM spend_requests WHERE project_id=? UNION SELECT 1 FROM expenses WHERE project_id=? LIMIT 1',
            )
            .get(projectId, projectId)),
          409,
          'Currency cannot change after financial records have been created.',
          'currency_in_use',
        );
      const allocations =
        input.allocations ??
        rows(
          await db
            .prepare('SELECT name,amount_cents FROM allocations WHERE project_id=?')
            .all(projectId),
        );
      validAllocations(allocations, allocated);
      await db
        .prepare(
          'UPDATE projects SET name=?,description=?,goal=?,status=?,currency=?,budget_cents=?,due_date=?,archived=?,version=version+1,updated_at=? WHERE id=?',
        )
        .run(
          input.name ?? project.name,
          input.description ?? project.description,
          input.goal ?? project.goal,
          input.status ?? project.status,
          input.currency ?? project.currency,
          allocated,
          input.dueDate === undefined ? project.due_date : input.dueDate,
          input.archived === undefined ? project.archived : Number(input.archived),
          now(),
          projectId,
        );
      if (input.allocations) await writeAllocations(projectId, input.allocations);
      await changed(
        workspaceId,
        req,
        'updated',
        'project',
        projectId,
        `Updated ${input.name ?? project.name}`,
        projectId,
      );
    });
    await notify(workspaceId);
    res.json({ project: await projectResponse(projectId, req.user.id) });
  });
  app.post('/api/projects/:projectId/tasks', async (req, res) => {
    let project;
    const input = schema.taskFields.parse(req.body);
    const taskId = id();
    const timestamp = now();
    await transaction(db, async () => {
      ({ project } = await projectContext(req.params.projectId, req.user.id));
      await validAssignee(project.workspace_id, input.assigneeId);

      await db
        .prepare(
          'INSERT INTO tasks(id,workspace_id,project_id,title,description,status,assignee_id,due_date,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          taskId,
          project.workspace_id,
          project.id,
          input.title,
          input.description,
          input.status,
          input.assigneeId,
          input.dueDate,
          req.user.id,
          timestamp,
          timestamp,
        );
      await changed(
        project.workspace_id,
        req,
        'created',
        'task',
        taskId,
        `Created ${input.title}`,
        project.id,
      );
    });
    await notify(project.workspace_id);
    res.status(201).json({ task: await one(db, 'tasks', taskId) });
  });
  app.patch('/api/tasks/:taskId', async (req, res) => {
    const input = schema.taskUpdate.parse(req.body);
    let workspaceId;
    await transaction(db, async () => {
      const task = await scoped(db, 'tasks', req.params.taskId, req.user.id, EDITORS);
      await projectContext(task.project_id, req.user.id);
      expectVersion(task, input.version);
      workspaceId = task.workspace_id;
      if (input.assigneeId !== undefined) await validAssignee(workspaceId, input.assigneeId);
      await db
        .prepare(
          'UPDATE tasks SET title=?,description=?,status=?,assignee_id=?,due_date=?,archived=?,version=version+1,updated_at=? WHERE id=?',
        )
        .run(
          input.title ?? task.title,
          input.description ?? task.description,
          input.status ?? task.status,
          input.assigneeId === undefined ? task.assignee_id : input.assigneeId,
          input.dueDate === undefined ? task.due_date : input.dueDate,
          input.archived === undefined ? task.archived : Number(input.archived),
          now(),
          task.id,
        );
      await changed(
        workspaceId,
        req,
        'updated',
        'task',
        task.id,
        `Updated ${input.title ?? task.title}`,
        task.project_id,
      );
    });
    await notify(workspaceId);
    res.json({ task: await one(db, 'tasks', req.params.taskId) });
  });
  app.post('/api/projects/:projectId/documents', async (req, res) => {
    let project;
    const input = schema.documentFields.parse(req.body);
    const documentId = id();
    const timestamp = now();
    await transaction(db, async () => {
      ({ project } = await projectContext(req.params.projectId, req.user.id));

      await db
        .prepare(
          'INSERT INTO documents(id,workspace_id,project_id,title,body,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          documentId,
          project.workspace_id,
          project.id,
          input.title,
          input.body,
          req.user.id,
          timestamp,
          timestamp,
        );
      await changed(
        project.workspace_id,
        req,
        'created',
        'document',
        documentId,
        `Created ${input.title}`,
        project.id,
      );
    });
    await notify(project.workspace_id);
    res.status(201).json({ document: await one(db, 'documents', documentId) });
  });
  app.patch('/api/documents/:documentId', async (req, res) => {
    const input = schema.documentUpdate.parse(req.body);
    let workspaceId;
    await transaction(db, async () => {
      const document = await scoped(db, 'documents', req.params.documentId, req.user.id, EDITORS);
      await projectContext(document.project_id, req.user.id);
      workspaceId = document.workspace_id;
      assert(
        document.version === input.version,
        409,
        'This document has a newer version. Your draft has not been overwritten.',
        'version_conflict',
        { currentVersion: document.version, current: camel(document) },
      );
      await db
        .prepare(
          'UPDATE documents SET title=?,body=?,archived=?,version=version+1,updated_at=? WHERE id=?',
        )
        .run(
          input.title ?? document.title,
          input.body ?? document.body,
          input.archived === undefined ? document.archived : Number(input.archived),
          now(),
          document.id,
        );
      await changed(
        workspaceId,
        req,
        'updated',
        'document',
        document.id,
        `Updated ${input.title ?? document.title}`,
        document.project_id,
      );
    });
    await notify(workspaceId);
    res.json({ document: await one(db, 'documents', req.params.documentId) });
  });
  app.post('/api/requests', async (req, res) => {
    const input = schema.requestInput.parse(req.body);
    let project;
    const requestId = id();
    const timestamp = now();
    await transaction(db, async () => {
      ({ project } = await projectContext(input.projectId, req.user.id));
      assert(
        input.approverId !== req.user.id,
        400,
        'Choose another admin to review your request.',
        'self_approval',
      );
      await member(db, project.workspace_id, input.approverId, ADMINS);
      if (input.taskId) {
        const task = await scoped(db, 'tasks', input.taskId, req.user.id);
        assert(
          task.project_id === project.id && !task.archived,
          400,
          'Choose a task from this project.',
          'invalid_task',
        );
      }

      await db
        .prepare(
          'INSERT INTO spend_requests(id,workspace_id,project_id,task_id,title,reason,amount_cents,category,requester_id,approver_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          requestId,
          project.workspace_id,
          project.id,
          input.taskId,
          input.title,
          input.reason,
          input.amountCents,
          input.category,
          req.user.id,
          input.approverId,
          timestamp,
          timestamp,
        );
      await changed(
        project.workspace_id,
        req,
        'submitted',
        'request',
        requestId,
        `Requested ${input.title}`,
        project.id,
      );
    });
    await notify(project.workspace_id);
    res.status(201).json({ request: await one(db, 'spend_requests', requestId) });
  });
  app.post('/api/requests/:requestId/action', async (req, res) => {
    const input = schema.requestAction.parse(req.body);
    let workspaceId;
    await transaction(db, async () => {
      const request = await scoped(
        db,
        'spend_requests',
        req.params.requestId,
        req.user.id,
        EDITORS,
      );
      workspaceId = request.workspace_id;
      const actor = await member(db, workspaceId, req.user.id);
      expectVersion(request, input.version);
      const isReviewer =
        request.approver_id === req.user.id &&
        ADMINS.includes(actor.role) &&
        request.requester_id !== req.user.id;
      if (input.action === 'approve' || input.action === 'decline') {
        assert(
          request.status === 'pending',
          409,
          'This request has already been reviewed.',
          'invalid_transition',
        );
        assert(
          isReviewer,
          403,
          'Only the assigned approver can review this request. You cannot approve your own spending.',
          'not_approver',
        );
        if (input.action === 'approve') {
          await projectContext(request.project_id, req.user.id);
          assert(
            request.amount_cents <= (await projectBudget(db, request.project_id)).available,
            409,
            'This request exceeds the available project budget.',
            'insufficient_budget',
          );
        } else
          assert(
            input.reason && input.reason.trim(),
            400,
            'Add a reason for declining.',
            'reason_required',
          );
        await db
          .prepare(
            'UPDATE spend_requests SET status=?,decline_reason=?,decision_at=?,version=version+1,updated_at=? WHERE id=?',
          )
          .run(
            input.action === 'approve' ? 'approved' : 'declined',
            input.action === 'decline' ? input.reason : null,
            now(),
            now(),
            request.id,
          );
      } else if (input.action === 'pay') {
        assert(
          request.status === 'approved',
          409,
          'Only an approved request can be recorded as paid.',
          'invalid_transition',
        );
        assert(
          ADMINS.includes(actor.role) || request.requester_id === req.user.id,
          403,
          'Only an admin or the requester can record this payment.',
          'forbidden',
        );
        const timestamp = now();
        await db
          .prepare(
            'INSERT INTO expenses(id,workspace_id,project_id,request_id,title,amount_cents,category,paid_on,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            id(),
            workspaceId,
            request.project_id,
            request.id,
            request.title,
            request.amount_cents,
            request.category,
            input.paidOn || timestamp.slice(0, 10),
            input.note || '',
            req.user.id,
            timestamp,
          );
        await db
          .prepare(
            "UPDATE spend_requests SET status='paid',paid_at=?,version=version+1,updated_at=? WHERE id=?",
          )
          .run(timestamp, timestamp, request.id);
      } else {
        assert(
          ['pending', 'approved'].includes(request.status),
          409,
          'Only pending or approved requests can be cancelled.',
          'invalid_transition',
        );
        assert(
          ADMINS.includes(actor.role) ||
            (request.requester_id === req.user.id && request.status === 'pending'),
          403,
          'Only an admin can release an approved commitment.',
          'forbidden',
        );
        await db
          .prepare(
            "UPDATE spend_requests SET status='cancelled',version=version+1,updated_at=? WHERE id=?",
          )
          .run(now(), request.id);
      }
      await changed(
        workspaceId,
        req,
        input.action,
        'request',
        request.id,
        `${input.action === 'pay' ? 'Recorded payment for' : input.action === 'approve' ? 'Approved' : input.action === 'decline' ? 'Declined' : 'Cancelled'} ${request.title}`,
        request.project_id,
      );
    });
    await notify(workspaceId);
    res.json({ request: await one(db, 'spend_requests', req.params.requestId) });
  });
  app.post('/api/expenses', async (req, res) => {
    const input = schema.expenseInput.parse(req.body);
    let project;
    const expenseId = id();
    await transaction(db, async () => {
      ({ project } = await projectContext(input.projectId, req.user.id, ADMINS));

      await db
        .prepare(
          'INSERT INTO expenses(id,workspace_id,project_id,title,amount_cents,category,paid_on,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          expenseId,
          project.workspace_id,
          project.id,
          input.title,
          input.amountCents,
          input.category,
          input.paidOn,
          input.note,
          req.user.id,
          now(),
        );
      await changed(
        project.workspace_id,
        req,
        'recorded',
        'expense',
        expenseId,
        `Recorded ${input.title}`,
        project.id,
      );
    });
    await notify(project.workspace_id);
    res.status(201).json({ expense: await one(db, 'expenses', expenseId) });
  });
  app.post('/api/expenses/:expenseId/void', async (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().min(1).max(2000) }).parse(req.body);
    let workspaceId;
    await transaction(db, async () => {
      const expense = await scoped(db, 'expenses', req.params.expenseId, req.user.id, ADMINS);
      workspaceId = expense.workspace_id;
      assert(
        expense.status === 'active',
        409,
        'This expense has already been voided.',
        'invalid_transition',
      );
      await db
        .prepare("UPDATE expenses SET status='void',void_reason=? WHERE id=?")
        .run(reason, expense.id);
      if (expense.request_id)
        await db
          .prepare(
            "UPDATE spend_requests SET status='void',version=version+1,updated_at=? WHERE id=?",
          )
          .run(now(), expense.request_id);
      await changed(
        workspaceId,
        req,
        'voided',
        'expense',
        expense.id,
        `Voided ${expense.title}: ${reason}`,
        expense.project_id,
      );
    });
    await notify(workspaceId);
    res.json({ expense: await one(db, 'expenses', req.params.expenseId) });
  });
  app.post('/api/workspaces/:workspaceId/comments', async (req, res) => {
    const workspaceId = req.params.workspaceId;
    await member(db, workspaceId, req.user.id, EDITORS);
    const input = schema.commentInput.parse(req.body);
    const table = { task: 'tasks', document: 'documents', request: 'spend_requests' }[
      input.entityType
    ];
    const entity = await scoped(db, table, input.entityId, req.user.id);
    assert(
      entity.workspace_id === workspaceId,
      404,
      'Item not found in this workspace.',
      'not_found',
    );
    const commentId = id();
    await transaction(db, async () => {
      await db
        .prepare(
          'INSERT INTO comments(id,workspace_id,project_id,entity_type,entity_id,body,author_id,created_at) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          commentId,
          workspaceId,
          entity.project_id,
          input.entityType,
          entity.id,
          input.body,
          req.user.id,
          now(),
        );
      await changed(
        workspaceId,
        req,
        'commented',
        input.entityType,
        entity.id,
        'Added a comment',
        entity.project_id,
      );
    });
    await notify(workspaceId);
    res.status(201).json({ comment: await one(db, 'comments', commentId) });
  });
  app.use('/api', (_req, _res, next) =>
    next(new HttpError(404, 'API endpoint not found.', 'not_found')),
  );
  const dist = options.distPath || resolve('dist');
  if (existsSync(resolve(dist, 'index.html'))) {
    app.use(
      express.static(dist, {
        index: false,
        maxAge: '1h',
        setHeaders: (res, path) => {
          if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
        },
      }),
    );
    app.get('/{*path}', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(resolve(dist, 'index.html'));
    });
  }
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return res.end();
    if (error instanceof z.ZodError)
      return res.status(400).json({
        error: 'Please check the fields and try again.',
        code: 'validation_error',
        fields: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    if (error instanceof HttpError)
      return res
        .status(error.status)
        .json({ error: error.message, code: error.code, ...error.extra });
    if (['40001', '40P01', '23505'].includes(error.code))
      return res.status(409).json({
        error: 'This item changed in another session. Refresh and try again.',
        code: 'version_conflict',
      });
    if (error.type === 'entity.too.large')
      return res.status(413).json({ error: 'This document is too large.', code: 'too_large' });
    if (error.type === 'entity.parse.failed')
      return res.status(400).json({ error: 'Invalid JSON.', code: 'invalid_json' });
    console.error('Orluma request failed:', error.message);
    res
      .status(500)
      .json({ error: 'Something went wrong. Please try again.', code: 'internal_error' });
  });
  return {
    app,
    db,
    identity,
    mail,
    close: async () => {
      stopMail();
      for (const entries of streams.values()) for (const entry of entries) entry.res.end();
      streams.clear();
      await db.close();
    },
  };
}
