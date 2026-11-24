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
      email TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin','member','viewer')),
      token_hash TEXT NOT NULL UNIQUE, expires_at BIGINT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
      used_at TEXT, used_by TEXT REFERENCES users(id), revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', goal TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('planned','active','paused','done')),
      currency TEXT NOT NULL DEFAULT 'USD', budget_cents BIGINT NOT NULL DEFAULT 0 CHECK (budget_cents >= 0),
      due_date TEXT, archived INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS allocations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0), UNIQUE(project_id,name)
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
      amount_cents BIGINT NOT NULL CHECK (amount_cents > 0), category TEXT NOT NULL,
      requester_id TEXT NOT NULL REFERENCES users(id), approver_id TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined','paid','cancelled','void')),
      decline_reason TEXT, decision_at TEXT, paid_at TEXT, version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      request_id TEXT UNIQUE REFERENCES spend_requests(id), title TEXT NOT NULL,
      amount_cents BIGINT NOT NULL CHECK (amount_cents > 0), category TEXT NOT NULL,
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
    CREATE INDEX IF NOT EXISTS projects_workspace ON projects(workspace_id);
    CREATE INDEX IF NOT EXISTS tasks_workspace ON tasks(workspace_id,project_id);
    CREATE INDEX IF NOT EXISTS documents_workspace ON documents(workspace_id,project_id);
    CREATE INDEX IF NOT EXISTS requests_workspace ON spend_requests(workspace_id,project_id,status);
    CREATE INDEX IF NOT EXISTS expenses_project ON expenses(project_id,status);
    CREATE INDEX IF NOT EXISTS comments_entity ON comments(workspace_id,entity_type,entity_id);
    CREATE INDEX IF NOT EXISTS activity_workspace ON activity(workspace_id,created_at);
