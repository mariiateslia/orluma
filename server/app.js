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
import {
  HttpError,
  assert,
  token,
  digest,
  hashPassword,
  checkPassword,
  cookies,
  sessionCookie,
  member,
  scoped,
  expectVersion,
} from './security.js';
import * as schema from './validation.js';

const EDITORS = ['owner', 'admin', 'member'];
const ADMINS = ['owner', 'admin'];
const SESSION_DAYS = 7;
const safeUser = (user) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  createdAt: user.created_at,
});
const one = (db, table, rowId) => camel(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(rowId));

export function createApplication(options = {}) {
  const db = openDatabase(
    options.dbPath || resolve(process.env.DATA_DIR || './data', 'orluma.sqlite'),
  );
  const appUrl = new URL(options.appUrl || process.env.APP_URL || 'http://localhost:3000');
  const development = options.development ?? process.env.NODE_ENV === 'development';
  const registrationMode = options.registrationMode || process.env.REGISTRATION_MODE || 'invite';
  const secure = appUrl.protocol === 'https:';
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
  app.use(express.json({ limit: '512kb' }));
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: options.disableRateLimit ? 100000 : 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please try again in 15 minutes.', code: 'rate_limited' },
  });
  const writeLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: options.disableRateLimit ? 100000 : 180,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: (req) => ['GET', 'HEAD', 'OPTIONS'].includes(req.method),
    message: { error: 'Too many changes. Please wait a minute.', code: 'rate_limited' },
  });
  app.use('/api', writeLimiter);

  function session(req, res) {
    const rawToken = cookies(req.headers.cookie).orluma_session;
    if (!rawToken) return null;
    const hash = digest(rawToken);
    const row = db
      .prepare(
        'SELECT users.*, sessions.expires_at FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=?',
      )
      .get(hash);
    if (!row || row.expires_at <= Date.now()) {
      if (row) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash);
      res.setHeader('Set-Cookie', sessionCookie('', { secure, maxAge: 0 }));
      return null;
    }
    req.sessionHash = hash;
    return row;
  }
  function requireUser(req, res, next) {
    req.user = session(req, res);
    assert(req.user, 401, 'Please sign in to continue.', 'unauthorized');
    next();
  }
  function startSession(userId, res) {
    const rawToken = token();
    db.prepare(
      'INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)',
    ).run(digest(rawToken), userId, Date.now() + SESSION_DAYS * 86400000, now());
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
    res.setHeader('Set-Cookie', sessionCookie(rawToken, { secure, maxAge: SESSION_DAYS * 86400 }));
  }
  function validStream(entry, workspaceId) {
    return db
      .prepare(
        'SELECT 1 FROM sessions JOIN memberships ON memberships.user_id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>? AND memberships.workspace_id=?',
      )
      .get(entry.sessionHash, Date.now(), workspaceId);
  }
  function notify(workspaceId, kind = 'changed') {
    for (const entry of streams.get(workspaceId) || []) {
      if (!validStream(entry, workspaceId)) {
        entry.res.end();
        continue;
      }
      entry.res.write(`event: update\ndata: ${JSON.stringify({ kind, at: now() })}\n\n`);
    }
  }
  function endSessionStreams(hash) {
    for (const entries of streams.values())
      for (const entry of entries) if (entry.sessionHash === hash) entry.res.end();
  }
  function changed(workspaceId, req, action, table, rowId, summary, projectId) {
    audit(db, workspaceId, req.user.id, action, table, rowId, summary, projectId);
  }
  function projectContext(projectId, userId, roles = EDITORS, allowArchived = false) {
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    assert(project, 404, 'Project not found.', 'not_found');
    const membership = member(db, project.workspace_id, userId, roles);
    assert(
      allowArchived || !project.archived,
      409,
      'Restore this project before making changes.',
      'archived',
    );
    return { project, membership };
  }
  function validAssignee(workspaceId, assigneeId) {
    if (assigneeId)
      assert(
        db
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
  function writeAllocations(projectId, allocations) {
    db.prepare('DELETE FROM allocations WHERE project_id=?').run(projectId);
    for (const allocation of allocations)
      db.prepare('INSERT INTO allocations(id,project_id,name,amount_cents) VALUES(?,?,?,?)').run(
        id(),
        projectId,
        allocation.name,
        allocation.amountCents,
      );
  }
  function invitationByToken(rawToken) {
    assert(
      typeof rawToken === 'string' && rawToken.length >= 20 && rawToken.length <= 200,
      400,
      'This invitation is invalid.',
      'invalid_invitation',
    );
    const invitation = db
      .prepare('SELECT * FROM invitations WHERE token_hash=?')
      .get(digest(rawToken));
    assert(
      invitation && !invitation.used_at && invitation.expires_at > Date.now(),
      400,
      'This invitation has expired or has already been used.',
      'invalid_invitation',
    );
    const inviter = db
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

  app.get('/api/health', (_req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  });
  app.get('/api/meta', (_req, res) => {
    const first = Number(db.prepare('SELECT COUNT(*) AS count FROM users').get().count) === 0;
    res.json({ registrationOpen: registrationMode === 'open' || first, firstAccount: first });
  });
  app.get('/api/auth/me', (req, res) => {
    const user = session(req, res);
    res.json({ user: user ? safeUser(user) : null });
  });
  app.post('/api/auth/register', authLimiter, async (req, res) => {
    const input = schema.registerInput.parse(req.body);
    const passwordHash = await hashPassword(input.password);
    let joinedWorkspaceId = null;
    const userId = transaction(db, () => {
      const first = Number(db.prepare('SELECT COUNT(*) AS count FROM users').get().count) === 0;
      const invitation = input.inviteToken ? invitationByToken(input.inviteToken) : null;
      assert(
        first || registrationMode === 'open' || invitation,
        403,
        'Ask your team for an invitation link.',
        'invitation_required',
      );
      if (invitation)
        assert(
          invitation.email.toLowerCase() === input.email,
          400,
          'Use the email address on your invitation.',
          'invitation_email_mismatch',
        );
      assert(
        !db.prepare('SELECT 1 FROM users WHERE email=?').get(input.email),
        409,
        'An account with this email already exists. Please sign in.',
        'account_exists',
      );
      const userId = id();
      db.prepare('INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)').run(
        userId,
        input.email,
        input.name,
        passwordHash,
        now(),
      );
      if (invitation) {
        db.prepare(
          'INSERT INTO memberships(workspace_id,user_id,role,joined_at) VALUES(?,?,?,?)',
        ).run(invitation.workspace_id, userId, invitation.role, now());
        db.prepare('UPDATE invitations SET used_at=? WHERE id=?').run(now(), invitation.id);
        audit(
          db,
          invitation.workspace_id,
          userId,
          'joined',
          'member',
          userId,
          `${input.name} joined the workspace`,
        );
        joinedWorkspaceId = invitation.workspace_id;
      }
      return userId;
    });
    startSession(userId, res);
    if (joinedWorkspaceId) notify(joinedWorkspaceId, 'member_joined');
    res.status(201).json({
      user: safeUser(db.prepare('SELECT * FROM users WHERE id=?').get(userId)),
      workspaceId: joinedWorkspaceId,
    });
  });
  app.post('/api/auth/login', authLimiter, async (req, res) => {
    const input = schema.loginInput.parse(req.body);
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(input.email);
    // Always run scrypt, including unknown accounts, to avoid a cheap timing distinction.
    const valid = await checkPassword(
      input.password,
      user?.password_hash || 'scrypt:00000000000000000000000000000000:' + '00'.repeat(64),
    );
    assert(user && valid, 401, 'Email or password is incorrect.', 'invalid_credentials');
    startSession(user.id, res);
    res.json({ user: safeUser(user) });
  });
  app.post('/api/auth/logout', requireUser, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.sessionHash);
    endSessionStreams(req.sessionHash);
    res.setHeader('Set-Cookie', sessionCookie('', { secure, maxAge: 0 })).json({ ok: true });
  });
  app.post('/api/auth/password', authLimiter, requireUser, async (req, res) => {
    const input = z
      .object({
        currentPassword: z.string().min(1).max(128),
        newPassword: z.string().min(12).max(128),
      })
      .parse(req.body);
    assert(
      await checkPassword(input.currentPassword, req.user.password_hash),
      400,
      'The current password is incorrect.',
      'invalid_credentials',
    );
    const hash = await hashPassword(input.newPassword);
    transaction(db, () => {
      const result = db
        .prepare('UPDATE users SET password_hash=? WHERE id=? AND password_hash=?')
        .run(hash, req.user.id, req.user.password_hash);
      assert(
        result.changes === 1,
        409,
        'Your password changed in another session. Sign in again.',
        'version_conflict',
      );
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.user.id);
    });
    for (const entries of streams.values())
      for (const entry of entries) if (entry.userId === req.user.id) entry.res.end();
    startSession(req.user.id, res);
    res.json({ ok: true });
  });

  app.get('/api/invitations/:token', (req, res) => {
    const invitation = invitationByToken(req.params.token);
    const workspace = db
      .prepare('SELECT name FROM workspaces WHERE id=?')
      .get(invitation.workspace_id);
    res.json({
      workspaceName: workspace.name,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expires_at,
    });
  });
  app.post('/api/invitations/accept', requireUser, (req, res) => {
    const input = z.object({ token: z.string().max(200) }).parse(req.body);
    const workspaceId = transaction(db, () => {
      const invitation = invitationByToken(input.token);
      assert(
        invitation.email.toLowerCase() === req.user.email.toLowerCase(),
        403,
        'Sign in with the invited email address.',
        'invitation_email_mismatch',
      );
      db.prepare(
        'INSERT OR IGNORE INTO memberships(workspace_id,user_id,role,joined_at) VALUES(?,?,?,?)',
      ).run(invitation.workspace_id, req.user.id, invitation.role, now());
      db.prepare('UPDATE invitations SET used_at=? WHERE id=?').run(now(), invitation.id);
      changed(
        invitation.workspace_id,
        req,
        'joined',
        'member',
        req.user.id,
        `${req.user.name} joined the workspace`,
      );
      return invitation.workspace_id;
    });
    notify(workspaceId, 'member_joined');
    res.json({ workspaceId });
  });

  app.use('/api', requireUser);
  app.get('/api/workspaces', (req, res) =>
    res.json({
      workspaces: rows(
        db
          .prepare(
            'SELECT workspaces.*, memberships.role FROM workspaces JOIN memberships ON memberships.workspace_id=workspaces.id WHERE memberships.user_id=? ORDER BY workspaces.created_at',
          )
          .all(req.user.id),
      ),
    }),
  );
  app.post('/api/workspaces', (req, res) => {
    const input = schema.workspaceInput.parse(req.body);
    const workspaceId = id();
    transaction(db, () => {
      db.prepare(
        'INSERT INTO workspaces(id,name,is_sample,created_by,created_at) VALUES(?,?,?,?,?)',
      ).run(workspaceId, input.name, input.sample ? 1 : 0, req.user.id, now());
      db.prepare(
        'INSERT INTO memberships(workspace_id,user_id,role,joined_at) VALUES(?,?,?,?)',
      ).run(workspaceId, req.user.id, 'owner', now());
      if (input.sample) seedSampleProject(db, workspaceId, req.user.id);
      changed(workspaceId, req, 'created', 'workspace', workspaceId, 'Created the workspace');
    });
    res.status(201).json({ workspace: { ...one(db, 'workspaces', workspaceId), role: 'owner' } });
  });
  app.get('/api/workspaces/:workspaceId/data', (req, res) => {
    const workspaceId = req.params.workspaceId;
    const membership = member(db, workspaceId, req.user.id);
    const projects = rows(
      db
        .prepare('SELECT * FROM projects WHERE workspace_id=? ORDER BY created_at DESC')
        .all(workspaceId),
    ).map((project) => ({ ...project, budget: projectBudget(db, project.id) }));
    res.json({
      workspace: { ...one(db, 'workspaces', workspaceId), role: membership.role },
      projects,
      members: rows(
        db
          .prepare(
            'SELECT users.id,users.name,users.email,memberships.role,memberships.joined_at FROM memberships JOIN users ON users.id=memberships.user_id WHERE workspace_id=? ORDER BY memberships.joined_at',
          )
          .all(workspaceId),
      ),
      tasks: rows(
        db
          .prepare('SELECT * FROM tasks WHERE workspace_id=? AND archived=0 ORDER BY created_at')
          .all(workspaceId),
      ),
      documents: rows(
        db
          .prepare(
            'SELECT * FROM documents WHERE workspace_id=? AND archived=0 ORDER BY updated_at DESC',
          )
          .all(workspaceId),
      ),
      requests: rows(
        db
          .prepare('SELECT * FROM spend_requests WHERE workspace_id=? ORDER BY created_at DESC')
          .all(workspaceId),
      ),
      expenses: rows(
        db
          .prepare(
            'SELECT * FROM expenses WHERE workspace_id=? ORDER BY paid_on DESC,created_at DESC',
          )
          .all(workspaceId),
      ),
      allocations: rows(
        db
          .prepare(
            'SELECT allocations.* FROM allocations JOIN projects ON projects.id=allocations.project_id WHERE projects.workspace_id=?',
          )
          .all(workspaceId),
      ),
      comments: rows(
        db
          .prepare('SELECT * FROM comments WHERE workspace_id=? ORDER BY created_at')
          .all(workspaceId),
      ),
      activity: rows(
        db
          .prepare(
            'SELECT activity.*,users.name AS actor_name FROM activity JOIN users ON users.id=activity.actor_id WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100',
          )
          .all(workspaceId),
      ),
    });
  });
  app.get('/api/workspaces/:workspaceId/events', (req, res) => {
    const workspaceId = req.params.workspaceId;
    member(db, workspaceId, req.user.id);
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\nevent: ready\ndata: {}\n\n');
    const entry = { res, userId: req.user.id, sessionHash: req.sessionHash };
    if (!streams.has(workspaceId)) streams.set(workspaceId, new Set());
    streams.get(workspaceId).add(entry);
    const interval = setInterval(() => {
      if (!validStream(entry, workspaceId)) res.end();
      else res.write(': heartbeat\n\n');
    }, 15000);
    req.on('close', () => {
      clearInterval(interval);
      streams.get(workspaceId)?.delete(entry);
      if (!streams.get(workspaceId)?.size) streams.delete(workspaceId);
    });
  });
  app.get('/api/workspaces/:workspaceId/export', (req, res) => {
    const workspaceId = req.params.workspaceId;
    member(db, workspaceId, req.user.id, ADMINS);
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
        db.prepare(`SELECT * FROM ${table} WHERE workspace_id=?`).all(workspaceId),
      );
    data.allocations = rows(
      db
        .prepare(
          'SELECT allocations.* FROM allocations JOIN projects ON projects.id=allocations.project_id WHERE workspace_id=?',
        )
        .all(workspaceId),
    );
    data.members = rows(
      db
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
      workspace: one(db, 'workspaces', workspaceId),
      data,
    });
  });
  app.get('/api/workspaces/:workspaceId/invitations', (req, res) => {
    member(db, req.params.workspaceId, req.user.id, ADMINS);
    res.json({
      invitations: rows(
        db
          .prepare(
            'SELECT id,email,role,expires_at,used_at,created_at FROM invitations WHERE workspace_id=? ORDER BY created_at DESC',
          )
          .all(req.params.workspaceId),
      ),
    });
  });
  app.post('/api/workspaces/:workspaceId/invitations', (req, res) => {
    const workspaceId = req.params.workspaceId;
    const actor = member(db, workspaceId, req.user.id, ADMINS);
    const input = schema.invitationInput.parse(req.body);
    assert(
      actor.role === 'owner' || input.role !== 'admin',
      403,
      'Only an owner can invite an admin.',
      'forbidden',
    );
    assert(
      !db
        .prepare(
          'SELECT 1 FROM memberships JOIN users ON users.id=memberships.user_id WHERE workspace_id=? AND users.email=?',
        )
        .get(workspaceId, input.email),
      409,
      'This person is already a workspace member.',
      'already_member',
    );
    const rawToken = token();
    const invitationId = id();
    const expires = Date.now() + 7 * 86400000;
    transaction(db, () => {
      db.prepare(
        'DELETE FROM invitations WHERE workspace_id=? AND email=? AND used_at IS NULL',
      ).run(workspaceId, input.email);
      db.prepare(
        'INSERT INTO invitations(id,workspace_id,email,role,token_hash,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)',
      ).run(
        invitationId,
        workspaceId,
        input.email,
        input.role,
        digest(rawToken),
        expires,
        req.user.id,
        now(),
      );
      changed(workspaceId, req, 'invited', 'member', invitationId, 'Created a team invitation');
    });
    notify(workspaceId, 'invitation_created');
    res.status(201).json({
      invitation: { id: invitationId, email: input.email, role: input.role, expiresAt: expires },
      inviteUrl: `${appUrl.origin}/#/invite/${rawToken}`,
    });
  });
  app.delete('/api/workspaces/:workspaceId/invitations/:invitationId', (req, res) => {
    const workspaceId = req.params.workspaceId;
    member(db, workspaceId, req.user.id, ADMINS);
    db.prepare('DELETE FROM invitations WHERE id=? AND workspace_id=? AND used_at IS NULL').run(
      req.params.invitationId,
      workspaceId,
    );
    notify(workspaceId);
    res.json({ ok: true });
  });
  app.patch('/api/workspaces/:workspaceId/members/:userId', (req, res) => {
    const workspaceId = req.params.workspaceId;
    const targetId = req.params.userId;
    const { role } = z.object({ role: schema.roles }).parse(req.body);
    transaction(db, () => {
      member(db, workspaceId, req.user.id, ['owner']);
      const target = member(db, workspaceId, targetId);
      if (target.role === 'owner' && role !== 'owner')
        assert(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM memberships WHERE workspace_id=? AND role='owner'",
            )
            .get(workspaceId).count > 1,
          409,
          'Keep at least one workspace owner.',
          'last_owner',
        );
      if (!ADMINS.includes(role))
        assert(
          !db
            .prepare(
              "SELECT 1 FROM spend_requests WHERE workspace_id=? AND approver_id=? AND status='pending' LIMIT 1",
            )
            .get(workspaceId, targetId),
          409,
          'Resolve this member’s pending approvals before changing their role.',
          'pending_approvals',
        );
      db.prepare('UPDATE memberships SET role=? WHERE workspace_id=? AND user_id=?').run(
        role,
        workspaceId,
        targetId,
      );
      if (!ADMINS.includes(role))
        db.prepare(
          'DELETE FROM invitations WHERE workspace_id=? AND created_by=? AND used_at IS NULL',
        ).run(workspaceId, targetId);
      changed(
        workspaceId,
        req,
        'role_changed',
        'member',
        targetId,
        `Changed a member’s role to ${role}`,
      );
    });
    notify(workspaceId, 'permissions_changed');
    res.json({ ok: true });
  });
  app.delete('/api/workspaces/:workspaceId/members/:userId', (req, res) => {
    const workspaceId = req.params.workspaceId;
    const targetId = req.params.userId;
    transaction(db, () => {
      const actor = member(db, workspaceId, req.user.id);
      const target = member(db, workspaceId, targetId);
      assert(
        targetId === req.user.id || actor.role === 'owner',
        403,
        'Only an owner can remove another member.',
        'forbidden',
      );
      if (target.role === 'owner')
        assert(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM memberships WHERE workspace_id=? AND role='owner'",
            )
            .get(workspaceId).count > 1,
          409,
          'Transfer ownership before leaving.',
          'last_owner',
        );
      assert(
        !db
          .prepare(
            "SELECT 1 FROM spend_requests WHERE workspace_id=? AND approver_id=? AND status='pending' LIMIT 1",
          )
          .get(workspaceId, targetId),
        409,
        'Resolve this member’s pending approvals before removing them.',
        'pending_approvals',
      );
      db.prepare('DELETE FROM memberships WHERE workspace_id=? AND user_id=?').run(
        workspaceId,
        targetId,
      );
      db.prepare(
        'DELETE FROM invitations WHERE workspace_id=? AND created_by=? AND used_at IS NULL',
      ).run(workspaceId, targetId);
      db.prepare(
        'UPDATE tasks SET assignee_id=NULL,version=version+1,updated_at=? WHERE workspace_id=? AND assignee_id=?',
      ).run(now(), workspaceId, targetId);
      changed(workspaceId, req, 'removed', 'member', targetId, 'Removed a workspace member');
    });
    notify(workspaceId, 'member_removed');
    res.json({ ok: true });
  });

  app.post('/api/workspaces/:workspaceId/projects', (req, res) => {
    const workspaceId = req.params.workspaceId;
    member(db, workspaceId, req.user.id, EDITORS);
    const input = schema.projectFields.parse(req.body);
    member(db, workspaceId, req.user.id, ADMINS); // Creating a budget is an admin responsibility.
    validAllocations(input.allocations, input.budgetCents);
    const projectId = id();
    const timestamp = now();
    transaction(db, () => {
      db.prepare(
        'INSERT INTO projects(id,workspace_id,name,description,goal,status,currency,budget_cents,due_date,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
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
      writeAllocations(projectId, input.allocations);
      changed(
        workspaceId,
        req,
        'created',
        'project',
        projectId,
        `Created ${input.name}`,
        projectId,
      );
    });
    notify(workspaceId);
    res.status(201).json({ project: one(db, 'projects', projectId) });
  });
  app.patch('/api/projects/:projectId', (req, res) => {
    const input = schema.projectUpdate.parse(req.body);
    const projectId = req.params.projectId;
    let workspaceId;
    transaction(db, () => {
      const { project, membership } = projectContext(projectId, req.user.id, EDITORS, true);
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
      const current = projectBudget(db, projectId);
      if (input.budgetCents !== undefined && allocated !== project.budget_cents)
        assert(
          allocated >= current.spent + current.reserved,
          409,
          'The budget cannot be lower than recorded spending and approved commitments.',
          'budget_in_use',
        );
      if (input.currency && input.currency !== project.currency)
        assert(
          !db
            .prepare(
              'SELECT 1 FROM spend_requests WHERE project_id=? UNION SELECT 1 FROM expenses WHERE project_id=? LIMIT 1',
            )
            .get(projectId, projectId),
          409,
          'Currency cannot change after financial records have been created.',
          'currency_in_use',
        );
      const allocations =
        input.allocations ??
        rows(
          db.prepare('SELECT name,amount_cents FROM allocations WHERE project_id=?').all(projectId),
        );
      validAllocations(allocations, allocated);
      db.prepare(
        'UPDATE projects SET name=?,description=?,goal=?,status=?,currency=?,budget_cents=?,due_date=?,archived=?,version=version+1,updated_at=? WHERE id=?',
      ).run(
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
      if (input.allocations) writeAllocations(projectId, input.allocations);
      changed(
        workspaceId,
        req,
        'updated',
        'project',
        projectId,
        `Updated ${input.name ?? project.name}`,
        projectId,
      );
    });
    notify(workspaceId);
    res.json({ project: one(db, 'projects', projectId) });
  });
  app.post('/api/projects/:projectId/tasks', (req, res) => {
    const { project } = projectContext(req.params.projectId, req.user.id);
    const input = schema.taskFields.parse(req.body);
    validAssignee(project.workspace_id, input.assigneeId);
    const taskId = id();
    const timestamp = now();
    transaction(db, () => {
      db.prepare(
        'INSERT INTO tasks(id,workspace_id,project_id,title,description,status,assignee_id,due_date,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
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
      changed(
        project.workspace_id,
        req,
        'created',
        'task',
        taskId,
        `Created ${input.title}`,
        project.id,
      );
    });
    notify(project.workspace_id);
    res.status(201).json({ task: one(db, 'tasks', taskId) });
  });
  app.patch('/api/tasks/:taskId', (req, res) => {
    const input = schema.taskUpdate.parse(req.body);
    let workspaceId;
    transaction(db, () => {
      const task = scoped(db, 'tasks', req.params.taskId, req.user.id, EDITORS);
      projectContext(task.project_id, req.user.id);
      expectVersion(task, input.version);
      workspaceId = task.workspace_id;
      if (input.assigneeId !== undefined) validAssignee(workspaceId, input.assigneeId);
      db.prepare(
        'UPDATE tasks SET title=?,description=?,status=?,assignee_id=?,due_date=?,archived=?,version=version+1,updated_at=? WHERE id=?',
      ).run(
        input.title ?? task.title,
        input.description ?? task.description,
        input.status ?? task.status,
        input.assigneeId === undefined ? task.assignee_id : input.assigneeId,
        input.dueDate === undefined ? task.due_date : input.dueDate,
        input.archived === undefined ? task.archived : Number(input.archived),
        now(),
        task.id,
      );
      changed(
        workspaceId,
        req,
        'updated',
        'task',
        task.id,
        `Updated ${input.title ?? task.title}`,
        task.project_id,
      );
    });
    notify(workspaceId);
    res.json({ task: one(db, 'tasks', req.params.taskId) });
  });
  app.post('/api/projects/:projectId/documents', (req, res) => {
    const { project } = projectContext(req.params.projectId, req.user.id);
    const input = schema.documentFields.parse(req.body);
    const documentId = id();
    const timestamp = now();
    transaction(db, () => {
      db.prepare(
        'INSERT INTO documents(id,workspace_id,project_id,title,body,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      ).run(
        documentId,
        project.workspace_id,
        project.id,
        input.title,
        input.body,
        req.user.id,
        timestamp,
        timestamp,
      );
      changed(
        project.workspace_id,
        req,
        'created',
        'document',
        documentId,
        `Created ${input.title}`,
        project.id,
      );
    });
    notify(project.workspace_id);
    res.status(201).json({ document: one(db, 'documents', documentId) });
  });
  app.patch('/api/documents/:documentId', (req, res) => {
    const input = schema.documentUpdate.parse(req.body);
    let workspaceId;
    transaction(db, () => {
      const document = scoped(db, 'documents', req.params.documentId, req.user.id, EDITORS);
      projectContext(document.project_id, req.user.id);
      workspaceId = document.workspace_id;
      assert(
        document.version === input.version,
        409,
        'This document has a newer version. Your draft has not been overwritten.',
        'version_conflict',
        { currentVersion: document.version, current: camel(document) },
      );
      db.prepare(
        'UPDATE documents SET title=?,body=?,archived=?,version=version+1,updated_at=? WHERE id=?',
      ).run(
        input.title ?? document.title,
        input.body ?? document.body,
        input.archived === undefined ? document.archived : Number(input.archived),
        now(),
        document.id,
      );
      changed(
        workspaceId,
        req,
        'updated',
        'document',
        document.id,
        `Updated ${input.title ?? document.title}`,
        document.project_id,
      );
    });
    notify(workspaceId);
    res.json({ document: one(db, 'documents', req.params.documentId) });
  });
  app.post('/api/requests', (req, res) => {
    const input = schema.requestInput.parse(req.body);
    const { project } = projectContext(input.projectId, req.user.id);
    assert(
      input.approverId !== req.user.id,
      400,
      'Choose another admin to review your request.',
      'self_approval',
    );
    member(db, project.workspace_id, input.approverId, ADMINS);
    if (input.taskId) {
      const task = scoped(db, 'tasks', input.taskId, req.user.id);
      assert(
        task.project_id === project.id && !task.archived,
        400,
        'Choose a task from this project.',
        'invalid_task',
      );
    }
    const requestId = id();
    const timestamp = now();
    transaction(db, () => {
      db.prepare(
        'INSERT INTO spend_requests(id,workspace_id,project_id,task_id,title,reason,amount_cents,category,requester_id,approver_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
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
      changed(
        project.workspace_id,
        req,
        'submitted',
        'request',
        requestId,
        `Requested ${input.title}`,
        project.id,
      );
    });
    notify(project.workspace_id);
    res.status(201).json({ request: one(db, 'spend_requests', requestId) });
  });
  app.post('/api/requests/:requestId/action', (req, res) => {
    const input = schema.requestAction.parse(req.body);
    let workspaceId;
    transaction(db, () => {
      const request = scoped(db, 'spend_requests', req.params.requestId, req.user.id, EDITORS);
      workspaceId = request.workspace_id;
      const actor = member(db, workspaceId, req.user.id);
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
          projectContext(request.project_id, req.user.id);
          assert(
            request.amount_cents <= projectBudget(db, request.project_id).available,
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
        db.prepare(
          'UPDATE spend_requests SET status=?,decline_reason=?,decision_at=?,version=version+1,updated_at=? WHERE id=?',
        ).run(
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
        db.prepare(
          'INSERT INTO expenses(id,workspace_id,project_id,request_id,title,amount_cents,category,paid_on,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        ).run(
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
        db.prepare(
          "UPDATE spend_requests SET status='paid',paid_at=?,version=version+1,updated_at=? WHERE id=?",
        ).run(timestamp, timestamp, request.id);
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
        db.prepare(
          "UPDATE spend_requests SET status='cancelled',version=version+1,updated_at=? WHERE id=?",
        ).run(now(), request.id);
      }
      changed(
        workspaceId,
        req,
        input.action,
        'request',
        request.id,
        `${input.action === 'pay' ? 'Recorded payment for' : input.action === 'approve' ? 'Approved' : input.action === 'decline' ? 'Declined' : 'Cancelled'} ${request.title}`,
        request.project_id,
      );
    });
    notify(workspaceId);
    res.json({ request: one(db, 'spend_requests', req.params.requestId) });
  });
  app.post('/api/expenses', (req, res) => {
    const input = schema.expenseInput.parse(req.body);
    const { project } = projectContext(input.projectId, req.user.id, ADMINS);
    const expenseId = id();
    transaction(db, () => {
      db.prepare(
        'INSERT INTO expenses(id,workspace_id,project_id,title,amount_cents,category,paid_on,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      ).run(
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
      changed(
        project.workspace_id,
        req,
        'recorded',
        'expense',
        expenseId,
        `Recorded ${input.title}`,
        project.id,
      );
    });
    notify(project.workspace_id);
    res.status(201).json({ expense: one(db, 'expenses', expenseId) });
  });
  app.post('/api/expenses/:expenseId/void', (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().min(1).max(2000) }).parse(req.body);
    let workspaceId;
    transaction(db, () => {
      const expense = scoped(db, 'expenses', req.params.expenseId, req.user.id, ADMINS);
      workspaceId = expense.workspace_id;
      assert(
        expense.status === 'active',
        409,
        'This expense has already been voided.',
        'invalid_transition',
      );
      db.prepare("UPDATE expenses SET status='void',void_reason=? WHERE id=?").run(
        reason,
        expense.id,
      );
      if (expense.request_id)
        db.prepare(
          "UPDATE spend_requests SET status='void',version=version+1,updated_at=? WHERE id=?",
        ).run(now(), expense.request_id);
      changed(
        workspaceId,
        req,
        'voided',
        'expense',
        expense.id,
        `Voided ${expense.title}: ${reason}`,
        expense.project_id,
      );
    });
    notify(workspaceId);
    res.json({ expense: one(db, 'expenses', req.params.expenseId) });
  });
  app.post('/api/workspaces/:workspaceId/comments', (req, res) => {
    const workspaceId = req.params.workspaceId;
    member(db, workspaceId, req.user.id, EDITORS);
    const input = schema.commentInput.parse(req.body);
    const table = { task: 'tasks', document: 'documents', request: 'spend_requests' }[
      input.entityType
    ];
    const entity = scoped(db, table, input.entityId, req.user.id);
    assert(
      entity.workspace_id === workspaceId,
      404,
      'Item not found in this workspace.',
      'not_found',
    );
    const commentId = id();
    transaction(db, () => {
      db.prepare(
        'INSERT INTO comments(id,workspace_id,project_id,entity_type,entity_id,body,author_id,created_at) VALUES(?,?,?,?,?,?,?,?)',
      ).run(
        commentId,
        workspaceId,
        entity.project_id,
        input.entityType,
        entity.id,
        input.body,
        req.user.id,
        now(),
      );
      changed(
        workspaceId,
        req,
        'commented',
        input.entityType,
        entity.id,
        'Added a comment',
        entity.project_id,
      );
    });
    notify(workspaceId);
    res.status(201).json({ comment: one(db, 'comments', commentId) });
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
    close: () => {
      for (const entries of streams.values()) for (const entry of entries) entry.res.end();
      streams.clear();
      db.close();
    },
  };
}
