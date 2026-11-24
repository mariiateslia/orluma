import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const camel = (row) =>
  row &&
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
      value,
    ]),
  );
export const rows = (values) => values.map(camel);

export function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE UNIQUE, name TEXT NOT NULL,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, is_sample INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memberships (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
      joined_at TEXT NOT NULL, PRIMARY KEY (workspace_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS invitations (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      email TEXT NOT NULL COLLATE NOCASE, role TEXT NOT NULL CHECK (role IN ('admin','member','viewer')),
      token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
      used_at TEXT, used_by TEXT REFERENCES users(id), revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', goal TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('planned','active','paused','done')),
      currency TEXT NOT NULL DEFAULT 'USD', budget_cents INTEGER NOT NULL DEFAULT 0 CHECK (budget_cents >= 0),
      due_date TEXT, archived INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS allocations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0), UNIQUE(project_id,name)
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done')),
      assignee_id TEXT REFERENCES users(id), due_date TEXT, version INTEGER NOT NULL DEFAULT 1,
      archived INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
      archived INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS spend_requests (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES tasks(id), title TEXT NOT NULL, reason TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0), category TEXT NOT NULL,
      requester_id TEXT NOT NULL REFERENCES users(id), approver_id TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined','paid','cancelled','void')),
      decline_reason TEXT, decision_at TEXT, paid_at TEXT, version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      request_id TEXT UNIQUE REFERENCES spend_requests(id), title TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0), category TEXT NOT NULL,
      paid_on TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','void')),
      void_reason TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('task','document','request')), entity_id TEXT NOT NULL,
      body TEXT NOT NULL, author_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL,
      entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS projects_workspace ON projects(workspace_id);
    CREATE INDEX IF NOT EXISTS tasks_workspace ON tasks(workspace_id,project_id);
    CREATE INDEX IF NOT EXISTS documents_workspace ON documents(workspace_id,project_id);
    CREATE INDEX IF NOT EXISTS requests_workspace ON spend_requests(workspace_id,project_id,status);
    CREATE INDEX IF NOT EXISTS expenses_project ON expenses(project_id,status);
    CREATE INDEX IF NOT EXISTS comments_entity ON comments(workspace_id,entity_type,entity_id);
    CREATE INDEX IF NOT EXISTS activity_workspace ON activity(workspace_id,created_at);
    INSERT OR IGNORE INTO schema_versions(version,applied_at) VALUES(1,datetime('now'));
  `);
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function projectBudget(db, projectId) {
  const project = db.prepare('SELECT budget_cents FROM projects WHERE id=?').get(projectId);
  const spent = Number(
    db
      .prepare(
        "SELECT COALESCE(SUM(amount_cents),0) AS value FROM expenses WHERE project_id=? AND status='active'",
      )
      .get(projectId).value,
  );
  const reserved = Number(
    db
      .prepare(
        "SELECT COALESCE(SUM(amount_cents),0) AS value FROM spend_requests WHERE project_id=? AND status='approved'",
      )
      .get(projectId).value,
  );
  const allocated = Number(project?.budget_cents || 0);
  return { allocated, spent, reserved, available: allocated - spent - reserved };
}

export function audit(db, workspaceId, actorId, action, type, entityId, summary, projectId = null) {
  db.prepare(
    'INSERT INTO activity(id,workspace_id,project_id,actor_id,action,entity_type,entity_id,summary,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
  ).run(id(), workspaceId, projectId, actorId, action, type, entityId, summary, now());
}

export function seedSampleProject(db, workspaceId, userId) {
  const projectId = id();
  const timestamp = now();
  const due = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  db.prepare(
    'INSERT INTO projects(id,workspace_id,name,description,goal,currency,budget_cents,due_date,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    projectId,
    workspaceId,
    'Website launch',
    'A clearer home for our next chapter.',
    'Help new teams understand our product and start their first project with confidence.',
    'USD',
    500000,
    due,
    userId,
    timestamp,
    timestamp,
  );
  for (const [name, amount] of [
    ['Design', 240000],
    ['Software', 100000],
    ['Research', 120000],
    ['Buffer', 40000],
  ]) {
    db.prepare('INSERT INTO allocations(id,project_id,name,amount_cents) VALUES(?,?,?,?)').run(
      id(),
      projectId,
      name,
      amount,
    );
  }
  const titles = [
    'Commission launch illustrations',
    'Build the landing page',
    'Approve launch messaging',
    'QA responsive layouts',
    'Define page structure',
    'Complete audience interviews',
  ];
  titles.forEach((title, i) =>
    db
      .prepare(
        'INSERT INTO tasks(id,workspace_id,project_id,title,description,status,assignee_id,due_date,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id(),
        workspaceId,
        projectId,
        title,
        i === 0
          ? 'Commission three custom scenes for the new website. Keep the direction warm, simple and consistent with the shared brief.'
          : '',
        i > 3 ? 'done' : i < 2 ? 'in_progress' : 'todo',
        userId,
        due,
        userId,
        timestamp,
        timestamp,
      ),
  );
  db.prepare(
    'INSERT INTO documents(id,workspace_id,project_id,title,body,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
  ).run(
    id(),
    workspaceId,
    projectId,
    'Website launch brief',
    '# Why we’re doing this\n\nOur product has grown. Our website should make its value easier to understand and help a new team start their first project with confidence.\n\n## What success looks like\n\nA new visitor can explain what the product does, see how it fits their team, and find a clear next step.\n\n## Illustration direction\n\nThree simple scenes that show a team planning, sharing context and making decisions. Warm, restrained and human.\n\n## Launch checklist\n\n- [ ] Final messaging\n- [ ] Three launch illustrations\n- [ ] Responsive QA\n',
    userId,
    timestamp,
    timestamp,
  );
  db.prepare(
    'INSERT INTO expenses(id,workspace_id,project_id,title,amount_cents,category,paid_on,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
  ).run(
    id(),
    workspaceId,
    projectId,
    'Research participant incentives',
    120000,
    'Research',
    timestamp.slice(0, 10),
    'Sample data. No actual payment was made.',
    userId,
    timestamp,
  );
  audit(
    db,
    workspaceId,
    userId,
    'created',
    'project',
    projectId,
    'Created the sample Website launch project',
    projectId,
  );
  return projectId;
}
