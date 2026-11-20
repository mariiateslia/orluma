import { useState } from 'react';
import { Plus, Pencil, FileText, CircleCheck, List, Columns3, Archive } from 'lucide-react';
import { api, dateLabel, money } from './api';
import { useApp } from './context';
import { Heading, Status, Avatar, Empty, Comments } from './ui';
import { ProjectDialog, TaskDialog, DocumentDialog, RequestDialog } from './forms';
import type { Project, Task, TaskStatus } from './types';

export function ProjectTabs({ project, active }: { project: Project; active: string }) {
  const { data, go } = useApp();
  return (
    <nav className="project-tabs" aria-label={project.name}>
      {[
        ['overview', 'Overview'],
        ['tasks', 'Tasks'],
        ['docs', 'Docs'],
        ['budget', 'Budget'],
      ].map(([tab, label]) => (
        <button
          key={tab}
          aria-current={active === tab ? 'page' : undefined}
          onClick={() => go(`/w/${data.workspace.id}/projects/${project.id}/${tab}`)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}
export function ProjectCover({ project, open = false }: { project: Project; open?: boolean }) {
  const { data, go } = useApp();
  return (
    <section className="project-cover">
      <div className="cover-copy">
        <span className="eyebrow">{data.workspace.name} / Project</span>
        <h2>{project.name}</h2>
        {open ? (
          <button
            className="button on-photo"
            onClick={() => go(`/w/${data.workspace.id}/projects/${project.id}/overview`)}
          >
            Open project
          </button>
        ) : (
          <span className="eyebrow">
            {project.dueDate
              ? 'Milestone / ' + dateLabel(project.dueDate)
              : 'A shared space for this project.'}
          </span>
        )}
      </div>
    </section>
  );
}
export function BudgetSummary({ project }: { project: Project }) {
  const { data, go } = useApp();
  return (
    <section className="inset budget-summary">
      <h2>Available to commit</h2>
      <div className={'mini-money' + (project.budget.available < 0 ? ' negative' : '')}>
        {money(project.budget.available, project.currency)}
      </div>
      <p>
        {money(project.budget.spent, project.currency)} spent /{' '}
        {money(project.budget.reserved, project.currency)} reserved
      </p>
      <button
        className="button"
        onClick={() => go(`/w/${data.workspace.id}/projects/${project.id}/budget`)}
      >
        Project budget
      </button>
    </section>
  );
}
export function TaskList({ tasks }: { tasks: Task[] }) {
  const { data, go, canEdit, refresh, notify } = useApp();
  const [saving, setSaving] = useState<Set<string>>(new Set());
  async function complete(task: Task, checked: boolean) {
    setSaving((old) => new Set(old).add(task.id));
    try {
      await api('/tasks/' + task.id, 'PATCH', {
        version: task.version,
        status: checked ? 'done' : 'in_progress',
      });
      await refresh();
    } catch (e) {
      notify((e as Error).message, true);
      await refresh().catch(() => {});
    } finally {
      setSaving((old) => {
        const next = new Set(old);
        next.delete(task.id);
        return next;
      });
    }
  }
  return (
    <div className="task-list">
      {tasks.map((task) => {
        const assignee = data.members.find((m) => m.id === task.assigneeId);
        return (
          <div className="work-row" key={task.id}>
            <div className="row-main">
              <input
                className="task-check"
                type="checkbox"
                checked={task.status === 'done'}
                disabled={
                  !canEdit ||
                  saving.has(task.id) ||
                  Boolean(data.projects.find((p) => p.id === task.projectId)?.archived)
                }
                onChange={(e) => {
                  void complete(task, e.target.checked);
                }}
                aria-label={'Complete ' + task.title}
              />
              <div>
                <button
                  className="row-title text-button"
                  onClick={() => go(`/w/${data.workspace.id}/tasks/${task.id}`)}
                >
                  {task.title}
                </button>
                <div className="row-meta">
                  {dateLabel(task.dueDate)}
                  <span>{data.projects.find((p) => p.id === task.projectId)?.name}</span>
                </div>
              </div>
            </div>
            <div className="row-end">
              <Status status={task.status} />
              {assignee ? (
                <Avatar name={assignee.name} />
              ) : (
                <span className="metadata">Unassigned</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
export function ProjectList() {
  const { data, admin, go, refresh, notify } = useApp();
  const [create, setCreate] = useState(false);
  const [archived, setArchived] = useState(false);
  const projects = data.projects.filter((p) => Boolean(p.archived) === archived);
  async function restore(project: Project) {
    try {
      await api('/projects/' + project.id, 'PATCH', { version: project.version, archived: false });
      await refresh();
      notify('Project restored.');
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  return (
    <>
      <Heading
        muted="Shared"
        title="projects"
        sub="A clear place for every project."
        actions={
          admin && (
            <button className="button primary" onClick={() => setCreate(true)}>
              <Plus />
              New project
            </button>
          )
        }
      />
      <div className="view-switch" role="group" aria-label="Project status">
        <button aria-pressed={!archived} onClick={() => setArchived(false)}>
          Active
        </button>
        <button aria-pressed={archived} onClick={() => setArchived(true)}>
          Archived
        </button>
      </div>
      {projects.length ? (
        <div className="project-grid">
          {projects.map((project) => {
            const tasks = data.tasks.filter((t) => t.projectId === project.id);
            const completed = tasks.filter((t) => t.status === 'done').length;
            return (
              <article className="project-tile" key={project.id}>
                <button
                  className="tile-cover"
                  aria-label={'Open ' + project.name}
                  onClick={() => go(`/w/${data.workspace.id}/projects/${project.id}/overview`)}
                >
                  <span>{project.name}</span>
                </button>
                <div className="tile-content">
                  <div className="section-heading">
                    <button
                      className="text-button"
                      onClick={() => go(`/w/${data.workspace.id}/projects/${project.id}/overview`)}
                    >
                      <h2>{project.name}</h2>
                    </button>
                    <Status status={project.status} />
                  </div>
                  <p>{project.description || project.goal || 'A shared project for your team.'}</p>
                  <div className="tile-bottom">
                    <span className="metadata">
                      {completed}/{tasks.length} tasks / {dateLabel(project.dueDate)}
                    </span>
                    {archived && admin && (
                      <button
                        className="text-button"
                        onClick={() => {
                          void restore(project);
                        }}
                      >
                        Restore
                      </button>
                    )}
                  </div>
                  <div
                    className="progress"
                    role="progressbar"
                    aria-label={project.name + ' task progress'}
                    aria-valuemin={0}
                    aria-valuemax={tasks.length || 1}
                    aria-valuenow={completed}
                  >
                    <span
                      style={{ width: (tasks.length ? (completed / tasks.length) * 100 : 0) + '%' }}
                    />
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <Empty
          title={archived ? 'No archived projects' : 'Make room for your first project'}
          body={
            archived
              ? 'Archived projects stay available for reference.'
              : 'Start with a goal, then add tasks, documents and a project budget.'
          }
          action={
            admin &&
            !archived && (
              <button className="button primary" onClick={() => setCreate(true)}>
                Create project
              </button>
            )
          }
        />
      )}
      {create && <ProjectDialog onClose={() => setCreate(false)} />}
    </>
  );
}
export function ProjectOverview({ project }: { project: Project }) {
  const { data, admin, canEdit, go, refresh, notify } = useApp();
  const [edit, setEdit] = useState(false);
  const [task, setTask] = useState(false);
  const [doc, setDoc] = useState(false);
  const tasks = data.tasks.filter((t) => t.projectId === project.id);
  const docs = data.documents.filter((d) => d.projectId === project.id && !d.archived);
  const activity = data.activity.filter((a) => a.projectId === project.id).slice(0, 5);
  async function archive() {
    if (!window.confirm('Archive this project? Your data stays available under Archived projects.'))
      return;
    try {
      await api('/projects/' + project.id, 'PATCH', { version: project.version, archived: true });
      await refresh();
      go(`/w/${data.workspace.id}/projects`);
      notify('Project archived.');
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  return (
    <>
      <Heading
        muted="Shared"
        title="project"
        sub={project.description}
        actions={
          <>
            {<Status status={project.status} />}
            {admin && (
              <button className="button" onClick={() => setEdit(true)}>
                <Pencil />
                Edit project
              </button>
            )}
          </>
        }
      />
      <ProjectTabs project={project} active="overview" />
      {project.archived && (
        <div className="notice">
          This project is archived. Restore it from Projects to make changes.
        </div>
      )}
      <ProjectCover project={project} />
      <div className="overview-grid">
        <div>
          <h2 className="section-label">What we’re working toward</h2>
          <p className="project-goal">
            {project.goal || 'Add a goal to give the team a shared direction.'}
          </p>
          <div className="section-heading">
            <h2>Moving forward</h2>
            {canEdit && !project.archived && (
              <button className="text-button" onClick={() => setTask(true)}>
                <Plus />
                New task
              </button>
            )}
          </div>
          {tasks.length ? (
            <TaskList tasks={tasks.filter((t) => t.status !== 'done').slice(0, 4)} />
          ) : (
            <p className="muted">No tasks yet. Add the first next step.</p>
          )}
          {tasks.length > 0 && (
            <button
              className="text-button section-link"
              onClick={() => go(`/w/${data.workspace.id}/projects/${project.id}/tasks`)}
            >
              View all {tasks.length} tasks
            </button>
          )}
          <section className="activity-section">
            <h2>Latest activity</h2>
            {activity.length ? (
              activity.map((item) => (
                <div className="activity-item" key={item.id}>
                  <Avatar name={item.actorName} />
                  <div>
                    <p>{item.summary}</p>
                    <span className="metadata">
                      {item.actorName} / {dateLabel(item.createdAt)}
                    </span>
                  </div>
                </div>
              ))
            ) : (
              <p className="muted">Changes will appear here as the team works.</p>
            )}
          </section>
        </div>
        <div className="stack">
          <BudgetSummary project={project} />
          <section>
            <div className="section-heading">
              <h2>Project context</h2>
              {canEdit && !project.archived && (
                <button className="text-button" onClick={() => setDoc(true)}>
                  <Plus />
                  New doc
                </button>
              )}
            </div>
            {docs.map((document) => (
              <button
                className="document-link"
                key={document.id}
                onClick={() => go(`/w/${data.workspace.id}/documents/${document.id}`)}
              >
                <span className="emboss-icon small">
                  <FileText />
                </span>
                <span>
                  {document.title}
                  <small>Updated {dateLabel(document.updatedAt)}</small>
                </span>
              </button>
            ))}
            {!docs.length && <p className="muted">Keep briefs and decisions close to the work.</p>}
          </section>
          {admin && !project.archived && (
            <button
              className="text-button muted"
              onClick={() => {
                void archive();
              }}
            >
              <Archive />
              Archive project
            </button>
          )}
        </div>
      </div>
      {edit && <ProjectDialog project={project} onClose={() => setEdit(false)} />}
      {task && <TaskDialog projectId={project.id} onClose={() => setTask(false)} />}
      {doc && <DocumentDialog projectId={project.id} onClose={() => setDoc(false)} />}
    </>
  );
}
export function TasksPage({
  project,
  personal = false,
}: {
  project?: Project;
  personal?: boolean;
}) {
  const { data, user, canEdit, go, refresh, notify } = useApp();
  const [create, setCreate] = useState(false);
  const [board, setBoard] = useState(false);
  const [filter, setFilter] = useState('all');
  const activeProjects = new Set(data.projects.filter((p) => !p.archived).map((p) => p.id));
  const tasks = data.tasks.filter(
    (t) =>
      activeProjects.has(t.projectId) &&
      (!project || t.projectId === project.id) &&
      (!personal || t.assigneeId === user.id) &&
      (filter === 'all' || t.status === filter),
  );
  async function move(taskId: string, status: TaskStatus) {
    const task = data.tasks.find((t) => t.id === taskId);
    if (!task || task.status === status) return;
    try {
      await api('/tasks/' + task.id, 'PATCH', { version: task.version, status });
      await refresh();
    } catch (e) {
      notify((e as Error).message, true);
      await refresh().catch(() => {});
    }
  }
  return (
    <>
      <Heading
        muted={personal ? 'Your' : 'Project'}
        title={personal ? 'work' : 'tasks'}
        sub={project?.name || 'Your next steps, with the context already attached.'}
        actions={
          canEdit &&
          activeProjects.size > 0 &&
          !project?.archived && (
            <button className="button primary" onClick={() => setCreate(true)}>
              <Plus />
              New task
            </button>
          )
        }
      />
      {project && <ProjectTabs project={project} active="tasks" />}
      <div className="list-toolbar">
        <div className="view-switch" role="group" aria-label="Task status">
          {[
            ['all', 'All'],
            ['todo', 'To do'],
            ['in_progress', 'In progress'],
            ['done', 'Done'],
          ].map(([value, label]) => (
            <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>
              {label}
            </button>
          ))}
        </div>
        <div className="view-switch" role="group" aria-label="Task layout">
          <button aria-pressed={!board} onClick={() => setBoard(false)}>
            <List />
            List
          </button>
          <button aria-pressed={board} onClick={() => setBoard(true)}>
            <Columns3 />
            Board
          </button>
        </div>
      </div>
      {!tasks.length ? (
        <Empty
          title={personal ? 'A little breathing room' : 'No tasks in this view'}
          body={
            personal
              ? 'Tasks assigned to you will appear here.'
              : 'Add a task or choose another status to see the work.'
          }
        />
      ) : board ? (
        <div className="task-board">
          {(['todo', 'in_progress', 'done'] as TaskStatus[]).map((status) => (
            <section
              key={status}
              className="board-column"
              onDragOver={(event) => {
                if (canEdit) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (canEdit) void move(event.dataTransfer.getData('text/plain'), status);
              }}
            >
              <h2>
                <Status status={status} />
                <span className="metadata">{tasks.filter((t) => t.status === status).length}</span>
              </h2>
              {tasks
                .filter((t) => t.status === status)
                .map((task) => (
                  <button
                    draggable={canEdit}
                    onDragStart={(event) => event.dataTransfer.setData('text/plain', task.id)}
                    className="task-card"
                    key={task.id}
                    onClick={() => go(`/w/${data.workspace.id}/tasks/${task.id}`)}
                  >
                    <span>{task.title}</span>
                    <div>
                      <span className="metadata">{dateLabel(task.dueDate)}</span>
                      {task.assigneeId && (
                        <Avatar
                          name={
                            data.members.find((m) => m.id === task.assigneeId)?.name ||
                            'Former member'
                          }
                        />
                      )}
                    </div>
                  </button>
                ))}
            </section>
          ))}
        </div>
      ) : (
        <TaskList tasks={tasks} />
      )}
      {create && <TaskDialog projectId={project?.id} onClose={() => setCreate(false)} />}
    </>
  );
}
export function TaskDetail({ task }: { task: Task }) {
  const { data, canEdit, go, refresh, notify } = useApp();
  const [edit, setEdit] = useState(false);
  const [request, setRequest] = useState(false);
  const [saving, setSaving] = useState(false);
  const project = data.projects.find((p) => p.id === task.projectId)!;
  const assignee = data.members.find((m) => m.id === task.assigneeId);
  const requests = data.requests.filter((r) => r.taskId === task.id);
  const docs = data.documents.filter((d) => d.projectId === task.projectId && !d.archived);
  async function status(value: TaskStatus) {
    setSaving(true);
    try {
      await api('/tasks/' + task.id, 'PATCH', { version: task.version, status: value });
      await refresh();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <Heading
        muted="Project"
        title="task"
        sub={project.name}
        actions={
          <>
            <button
              className="button"
              onClick={() => go(`/w/${data.workspace.id}/projects/${project.id}/tasks`)}
            >
              Back to tasks
            </button>
            {canEdit && !project.archived && (
              <button className="button" onClick={() => setEdit(true)}>
                <Pencil />
                Edit task
              </button>
            )}
          </>
        }
      />
      <div className="detail-grid">
        <section>
          <div className="emboss-icon">
            <CircleCheck />
          </div>
          <h2 className="detail-title">{task.title}</h2>
          <p className="preserve-lines muted">
            {task.description || 'Add a description so the team has the context.'}
          </p>
          <section className="related-section">
            <div className="section-heading">
              <h2>Linked spending</h2>
              {canEdit && !project.archived && (
                <button className="text-button" onClick={() => setRequest(true)}>
                  <Plus />
                  Request spend
                </button>
              )}
            </div>
            {requests.map((r) => (
              <button
                className="context-link"
                key={r.id}
                onClick={() => go(`/w/${data.workspace.id}/requests/${r.id}`)}
              >
                <span>
                  {r.title} / {money(r.amountCents, project.currency)}
                </span>
                <Status status={r.status} />
              </button>
            ))}
            {!requests.length && <p className="muted">No spending requests linked to this task.</p>}
          </section>
          <section className="related-section">
            <h2>Project documents</h2>
            {docs.map((d) => (
              <button
                className="context-link"
                key={d.id}
                onClick={() => go(`/w/${data.workspace.id}/documents/${d.id}`)}
              >
                <FileText />
                {d.title}
              </button>
            ))}
          </section>
        </section>
        <section className="inset">
          <h2>Task details</h2>
          <label className="field">
            <span>Status</span>
            <select
              value={task.status}
              disabled={!canEdit || saving || Boolean(project.archived)}
              onChange={(e) => {
                void status(e.target.value as TaskStatus);
              }}
            >
              <option value="todo">To do</option>
              <option value="in_progress">In progress</option>
              <option value="done">Done</option>
            </select>
          </label>
          <div className="property">
            <span>Assigned to</span>
            <div>
              {assignee ? (
                <>
                  <Avatar name={assignee.name} />
                  {assignee.name}
                </>
              ) : (
                'Unassigned'
              )}
            </div>
          </div>
          <div className="property">
            <span>Due date</span>
            <div>{dateLabel(task.dueDate)}</div>
          </div>
          <div className="property">
            <span>Project</span>
            <button
              className="text-button"
              onClick={() => go(`/w/${data.workspace.id}/projects/${project.id}/overview`)}
            >
              {project.name}
            </button>
          </div>
          <div className="property">
            <span>Last updated</span>
            <div>{dateLabel(task.updatedAt)}</div>
          </div>
        </section>
      </div>
      <Comments type="task" id={task.id} />
      {edit && <TaskDialog task={task} onClose={() => setEdit(false)} />}
      {request && <RequestDialog task={task} onClose={() => setRequest(false)} />}
    </>
  );
}
