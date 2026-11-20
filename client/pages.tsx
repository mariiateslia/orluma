import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useApp } from './context';
import { Heading, Empty } from './ui';
import {
  BudgetSummary,
  ProjectCover,
  ProjectList,
  ProjectOverview,
  TaskDetail,
  TaskList,
  TasksPage,
} from './Work';
import { BudgetPage, SpendingPage, RequestCard, RequestDetail, ExpenseDetail } from './Spending';
import { DocumentsPage, DocumentPage } from './Docs';
import { TeamPage, SettingsPage } from './Team';
import { ProjectDialog } from './forms';

function Home() {
  const { data, user, admin } = useApp();
  const [create, setCreate] = useState(false);
  const active = data.projects.filter((p) => !p.archived);
  const project = active[0];
  const tasks = data.tasks.filter(
    (t) =>
      t.assigneeId === user.id && t.status !== 'done' && active.some((p) => p.id === t.projectId),
  );
  return (
    <>
      <Heading
        muted="A little"
        title="clarity."
        sub={
          new Intl.DateTimeFormat('en-US', {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
          }).format(new Date()) +
          ' / ' +
          data.workspace.name
        }
        actions={
          admin && (
            <button className="button" onClick={() => setCreate(true)}>
              <Plus />
              New project
            </button>
          )
        }
      />
      {project ? (
        <>
          <div className="home-lead">
            <ProjectCover project={project} open />
            <RequestCard />
          </div>
          <div className="overview-grid">
            <section>
              <div className="section-heading">
                <h2>Your next steps</h2>
                <span className="metadata">{tasks.length} open tasks</span>
              </div>
              {tasks.length ? (
                <TaskList tasks={tasks.slice(0, 5)} />
              ) : (
                <p className="muted empty-inline">
                  Tasks assigned to you will appear here. A little breathing room for now.
                </p>
              )}
            </section>
            <BudgetSummary project={project} />
          </div>
        </>
      ) : (
        <Empty
          title="Your next project starts here"
          body={
            admin
              ? 'Create a project to bring the work, context and budget together.'
              : 'Ask an admin to create the first project for your team.'
          }
          action={
            admin && (
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
export function WorkspacePages() {
  const { data, route, go } = useApp();
  const unavailable = (
    <Empty
      title="This item is unavailable"
      body="It may have been archived or belong to another workspace."
      action={
        <button className="button" onClick={() => go(`/w/${data.workspace.id}/projects`)}>
          Open projects
        </button>
      }
    />
  );
  if (route.section === 'projects' && route.id) {
    const project = data.projects.find((p) => p.id === route.id);
    if (!project) return unavailable;
    if (route.tab === 'tasks') return <TasksPage key={project.id} project={project} />;
    if (route.tab === 'docs') return <DocumentsPage key={project.id} project={project} />;
    if (route.tab === 'budget') return <BudgetPage key={project.id} project={project} />;
    return <ProjectOverview key={project.id} project={project} />;
  }
  if (route.section === 'tasks' && route.id) {
    const task = data.tasks.find((t) => t.id === route.id);
    return task ? <TaskDetail key={task.id} task={task} /> : unavailable;
  }
  if (route.section === 'documents' && route.id) {
    const document = data.documents.find((d) => d.id === route.id);
    return document ? <DocumentPage key={document.id} document={document} /> : unavailable;
  }
  if (route.section === 'requests' && route.id) {
    const request = data.requests.find((r) => r.id === route.id);
    return request ? <RequestDetail key={request.id} request={request} /> : unavailable;
  }
  if (route.section === 'expenses' && route.id) {
    const expense = data.expenses.find((e) => e.id === route.id);
    return expense ? <ExpenseDetail key={expense.id} expense={expense} /> : unavailable;
  }
  switch (route.section) {
    case 'projects':
      return <ProjectList />;
    case 'my-work':
      return <TasksPage personal />;
    case 'docs':
      return <DocumentsPage />;
    case 'spending':
      return <SpendingPage />;
    case 'team':
      return <TeamPage />;
    case 'settings':
      return <SettingsPage />;
    default:
      return <Home />;
  }
}
