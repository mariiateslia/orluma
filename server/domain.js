import { id, now } from './database.js';
export async function projectBudget(db, projectId) {
  const project = await db.prepare('SELECT budget_cents FROM projects WHERE id=?').get(projectId);
  const spent = Number(
    (
      await db
        .prepare(
          "SELECT COALESCE(SUM(amount_cents),0) AS value FROM expenses WHERE project_id=? AND status='active'",
        )
        .get(projectId)
    ).value,
  );
  const reserved = Number(
    (
      await db
        .prepare(
          "SELECT COALESCE(SUM(amount_cents),0) AS value FROM spend_requests WHERE project_id=? AND status='approved'",
        )
        .get(projectId)
    ).value,
  );
  const allocated = Number(project?.budget_cents || 0);
  return { allocated, spent, reserved, available: allocated - spent - reserved };
}
export async function audit(
  db,
  workspaceId,
  actorId,
  action,
  type,
  entityId,
  summary,
  projectId = null,
) {
  await db
    .prepare(
      'INSERT INTO activity(id,workspace_id,project_id,actor_id,action,entity_type,entity_id,summary,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    )
    .run(id(), workspaceId, projectId, actorId, action, type, entityId, summary, now());
}
export async function seedSampleProject(db, workspaceId, userId) {
  const projectId = id();
  const timestamp = now();
  const due = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  await db
    .prepare(
      'INSERT INTO projects(id,workspace_id,name,description,goal,currency,budget_cents,due_date,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
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
    await db
      .prepare('INSERT INTO allocations(id,project_id,name,amount_cents) VALUES(?,?,?,?)')
      .run(id(), projectId, name, amount);
  }
  const titles = [
    'Commission launch illustrations',
    'Build the landing page',
    'Approve launch messaging',
    'QA responsive layouts',
    'Define page structure',
    'Complete audience interviews',
  ];
  for (const [i, title] of titles.entries()) {
    await db
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
      );
  }
  await db
    .prepare(
      'INSERT INTO documents(id,workspace_id,project_id,title,body,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run(
      id(),
      workspaceId,
      projectId,
      'Website launch brief',
      '# Why we’re doing this\n\nOur product has grown. Our website should make its value easier to understand and help a new team start their first project with confidence.\n\n## What success looks like\n\nA new visitor can explain what the product does, see how it fits their team, and find a clear next step.\n\n## Illustration direction\n\nThree simple scenes that show a team planning, sharing context and making decisions. Warm, restrained and human.\n\n## Launch checklist\n\n- [ ] Final messaging\n- [ ] Three launch illustrations\n- [ ] Responsive QA\n',
      userId,
      timestamp,
      timestamp,
    );
  await db
    .prepare(
      'INSERT INTO expenses(id,workspace_id,project_id,title,amount_cents,category,paid_on,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
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
  await audit(
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
