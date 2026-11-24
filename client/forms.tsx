import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { api, money, moneyInput, parseMoney, today } from './api';
import { useApp } from './context';
import { Dialog, AsyncForm, Field, Empty } from './ui';
import type { Project, Task, Document, SpendRequest, Expense } from './types';

export function ProjectDialog({ project, onClose }: { project?: Project; onClose: () => void }) {
  const { data, refresh, notify, go, admin } = useApp();
  const [allocations, setAllocations] = useState(() =>
    project
      ? data.allocations
          .filter((a) => a.projectId === project.id)
          .map((a) => ({ name: a.name, amount: moneyInput(a.amountCents) }))
      : ([] as { name: string; amount: string }[]),
  );
  const financialRecords =
    project &&
    (data.requests.some((r) => r.projectId === project.id) ||
      data.expenses.some((e) => e.projectId === project.id));
  return (
    <Dialog title={project ? 'Edit project' : 'Create a project'} onClose={onClose} wide>
      <AsyncForm
        submitLabel={project ? 'Save changes' : 'Create project'}
        onCancel={onClose}
        onSubmit={async (form) => {
          const names = form.getAll('allocationName').map(String);
          const amounts = form.getAll('allocationAmount').map(String);
          const payload = {
            name: String(form.get('name')),
            description: String(form.get('description')),
            goal: String(form.get('goal')),
            status: String(form.get('status')),
            currency: String(form.get('currency') || project?.currency || 'USD'),
            budgetCents: parseMoney(String(form.get('budget') || '0')),
            dueDate: String(form.get('dueDate')) || null,
            allocations: names
              .map((name, index) => ({
                name: name.trim(),
                amountCents: parseMoney(amounts[index] || '0'),
              }))
              .filter((a) => a.name || a.amountCents),
          };
          if (payload.allocations.some((a) => !a.name))
            throw new Error('Give every allocation a name.');
          const { budgetCents, currency, allocations: financeAllocations, ...metadata } = payload;
          const visiblePayload = admin ? payload : metadata;
          const response = project
            ? await api<{ project: Project }>('/projects/' + project.id, 'PATCH', {
                ...visiblePayload,
                version: project.version,
              })
            : await api<{ project: Project }>(
                `/workspaces/${data.workspace.id}/projects`,
                'POST',
                payload,
              );
          await refresh();
          notify(project ? 'Project updated.' : 'Project created.');
          onClose();
          if (!project) go(`/w/${data.workspace.id}/projects/${response.project.id}/overview`);
        }}
      >
        <Field label="Project name">
          <input name="name" defaultValue={project?.name} required maxLength={140} autoFocus />
        </Field>
        <Field label="Short description">
          <textarea
            name="description"
            defaultValue={project?.description}
            maxLength={2000}
            rows={2}
          />
        </Field>
        <Field label="What are we working toward?">
          <textarea name="goal" defaultValue={project?.goal} maxLength={3000} rows={3} />
        </Field>
        <div className="form-grid">
          <Field label="Status">
            <select name="status" defaultValue={project?.status || 'active'}>
              <option value="planned">Planned</option>
              <option value="active">In progress</option>
              <option value="paused">Paused</option>
              <option value="done">Done</option>
            </select>
          </Field>
          <Field label="Target date">
            <input name="dueDate" type="date" defaultValue={project?.dueDate || ''} />
          </Field>
          {admin && (
            <>
              <Field label="Project budget">
                <input
                  name="budget"
                  inputMode="decimal"
                  defaultValue={project ? moneyInput(project.budgetCents ?? 0) : '0.00'}
                  required
                  pattern="[0-9]+([.][0-9]{1,2})?"
                />
              </Field>
              <Field
                label="Currency"
                hint={
                  financialRecords ? 'Currency is fixed once financial records exist.' : undefined
                }
              >
                <select
                  name="currency"
                  defaultValue={project?.currency || 'USD'}
                  disabled={Boolean(financialRecords)}
                >
                  {['USD', 'EUR', 'GBP', 'CAD', 'AUD'].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </Field>
            </>
          )}
        </div>
        {admin && (
          <section className="allocation-editor">
            <div className="section-heading">
              <h3>Budget allocations</h3>
              <button
                type="button"
                className="text-button"
                disabled={allocations.length >= 30}
                onClick={() => setAllocations([...allocations, { name: '', amount: '0.00' }])}
              >
                <Plus />
                Add category
              </button>
            </div>
            <p className="field-hint">
              Optional. Split the budget into categories; leave the rest unallocated.
            </p>
            {allocations.map((row, index) => (
              <div className="allocation-row" key={index}>
                <Field label={'Category ' + (index + 1)}>
                  <input
                    name="allocationName"
                    value={row.name}
                    onChange={(e) =>
                      setAllocations((current) =>
                        current.map((item, i) =>
                          i === index ? { ...item, name: e.target.value } : item,
                        ),
                      )
                    }
                    maxLength={60}
                    placeholder="e.g. Design"
                  />
                </Field>
                <Field label="Allocated amount">
                  <input
                    name="allocationAmount"
                    inputMode="decimal"
                    value={row.amount}
                    onChange={(e) =>
                      setAllocations((current) =>
                        current.map((item, i) =>
                          i === index ? { ...item, amount: e.target.value } : item,
                        ),
                      )
                    }
                    pattern="[0-9]+([.][0-9]{1,2})?"
                  />
                </Field>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={'Remove category ' + (index + 1)}
                  onClick={() => setAllocations(allocations.filter((_, i) => i !== index))}
                >
                  <X />
                </button>
              </div>
            ))}
          </section>
        )}
      </AsyncForm>
    </Dialog>
  );
}

export function TaskDialog({
  projectId,
  task,
  onClose,
}: {
  projectId?: string;
  task?: Task;
  onClose: () => void;
}) {
  const { data, refresh, notify, go } = useApp();
  const active = data.projects.filter((p) => !p.archived);
  return (
    <Dialog title={task ? 'Edit task' : 'Create a task'} onClose={onClose}>
      <AsyncForm
        submitLabel={task ? 'Save task' : 'Create task'}
        onCancel={onClose}
        onSubmit={async (form) => {
          const selected = task?.projectId || String(form.get('projectId') || projectId);
          const payload = {
            title: String(form.get('title')),
            description: String(form.get('description')),
            status: String(form.get('status')),
            assigneeId: String(form.get('assigneeId')) || null,
            dueDate: String(form.get('dueDate')) || null,
          };
          const response = task
            ? await api<{ task: Task }>('/tasks/' + task.id, 'PATCH', {
                ...payload,
                version: task.version,
              })
            : await api<{ task: Task }>('/projects/' + selected + '/tasks', 'POST', payload);
          await refresh();
          onClose();
          notify(task ? 'Task updated.' : 'Task created.');
          if (!task) go(`/w/${data.workspace.id}/tasks/${response.task.id}`);
        }}
      >
        {!task && !projectId && (
          <Field label="Project">
            <select name="projectId" required>
              {active.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Task name">
          <input name="title" required maxLength={200} defaultValue={task?.title} autoFocus />
        </Field>
        <Field label="Description">
          <textarea
            name="description"
            maxLength={10000}
            rows={5}
            defaultValue={task?.description}
          />
        </Field>
        <div className="form-grid">
          <Field label="Status">
            <select name="status" defaultValue={task?.status || 'todo'}>
              <option value="todo">To do</option>
              <option value="in_progress">In progress</option>
              <option value="done">Done</option>
            </select>
          </Field>
          <Field label="Assigned to">
            <select name="assigneeId" defaultValue={task?.assigneeId || ''}>
              <option value="">Unassigned</option>
              {data.members
                .filter((m) => m.role !== 'viewer')
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Due date">
            <input name="dueDate" type="date" defaultValue={task?.dueDate || ''} />
          </Field>
        </div>
      </AsyncForm>
    </Dialog>
  );
}

export function DocumentDialog({
  projectId,
  onClose,
}: {
  projectId?: string;
  onClose: () => void;
}) {
  const { data, refresh, notify, go } = useApp();
  return (
    <Dialog title="Create a document" onClose={onClose} wide>
      <AsyncForm
        submitLabel="Create document"
        onCancel={onClose}
        onSubmit={async (form) => {
          const selected = projectId || String(form.get('projectId'));
          const response = await api<{ document: Document }>(
            '/projects/' + selected + '/documents',
            'POST',
            { title: String(form.get('title')), body: String(form.get('body')) },
          );
          await refresh();
          onClose();
          notify('Document created.');
          go(`/w/${data.workspace.id}/documents/${response.document.id}`);
        }}
      >
        {!projectId && (
          <Field label="Project">
            <select name="projectId" required>
              {data.projects
                .filter((p) => !p.archived)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </Field>
        )}
        <Field label="Document title">
          <input name="title" required maxLength={200} autoFocus />
        </Field>
        <Field label="Content" hint="Markdown supports headings, lists and links.">
          <textarea name="body" rows={12} maxLength={200000} />
        </Field>
      </AsyncForm>
    </Dialog>
  );
}

export function RequestDialog({
  projectId,
  task,
  onClose,
}: {
  projectId?: string;
  task?: Task;
  onClose: () => void;
}) {
  const { data, user, refresh, notify, go } = useApp();
  const projects = data.projects.filter((p) => !p.archived);
  const [selected, setSelected] = useState(task?.projectId || projectId || projects[0]?.id || '');
  const project = projects.find((p) => p.id === selected);
  const approvers = data.members.filter(
    (m) => ['owner', 'admin'].includes(m.role) && m.id !== user.id,
  );
  const categories = data.allocations.filter((a) => a.projectId === selected).map((a) => a.name);
  return (
    <Dialog title="Request spending" onClose={onClose}>
      {!approvers.length ? (
        <Empty
          title="Add an approver first"
          body="A request needs another owner or admin to review it. Invite a teammate or ask your owner to update someone’s role."
          action={
            <button
              className="button primary"
              onClick={() => {
                onClose();
                go(`/w/${data.workspace.id}/team`);
              }}
            >
              Open team
            </button>
          }
        />
      ) : (
        <AsyncForm
          submitLabel="Submit request"
          onCancel={onClose}
          onSubmit={async (form) => {
            const response = await api<{ request: SpendRequest }>('/requests', 'POST', {
              projectId: selected,
              taskId: String(form.get('taskId')) || null,
              title: String(form.get('title')),
              reason: String(form.get('reason')),
              amountCents: parseMoney(String(form.get('amount'))),
              category: String(form.get('category')),
              approverId: String(form.get('approverId')),
            });
            await refresh();
            onClose();
            notify('Spending request submitted.');
            go(`/w/${data.workspace.id}/requests/${response.request.id}`);
          }}
        >
          <Field label="Project">
            <select value={selected} onChange={(e) => setSelected(e.target.value)} required>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="What do you need?">
            <input name="title" required maxLength={200} autoFocus defaultValue={task?.title} />
          </Field>
          <div className="form-grid">
            <Field
              label={'Amount / ' + (project?.currency || 'USD')}
              hint={
                project?.budget
                  ? 'Available to commit: ' + money(project.budget.available, project.currency)
                  : undefined
              }
            >
              <input
                name="amount"
                inputMode="decimal"
                required
                pattern="[0-9]+([.][0-9]{1,2})?"
                placeholder="0.00"
              />
            </Field>
            <Field label="Budget category">
              <select name="category" key={selected}>
                {[...new Set([...categories, 'Other'])].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Why is this needed?">
            <textarea name="reason" required maxLength={5000} rows={4} />
          </Field>
          <Field label="Approver">
            <select name="approverId" required>
              <option value="">Choose another admin</option>
              {approvers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Linked task">
            <select
              name="taskId"
              key={selected}
              defaultValue={task?.projectId === selected ? task.id : ''}
            >
              <option value="">No linked task</option>
              {data.tasks
                .filter((t) => t.projectId === selected)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
            </select>
          </Field>
          <p className="field-hint">Approval reserves budget. Payments happen outside Orluma.</p>
        </AsyncForm>
      )}
    </Dialog>
  );
}

export function ExpenseDialog({ projectId, onClose }: { projectId?: string; onClose: () => void }) {
  const { data, refresh, notify } = useApp();
  const projects = data.projects.filter((p) => !p.archived);
  const [selected, setSelected] = useState(projectId || projects[0]?.id || '');
  const project = projects.find((p) => p.id === selected);
  return (
    <Dialog title="Record a payment" onClose={onClose}>
      <AsyncForm
        submitLabel="Record payment"
        onCancel={onClose}
        onSubmit={async (form) => {
          await api<{ expense: Expense }>('/expenses', 'POST', {
            projectId: selected,
            title: String(form.get('title')),
            amountCents: parseMoney(String(form.get('amount'))),
            category: String(form.get('category')),
            paidOn: String(form.get('paidOn')),
            note: String(form.get('note')),
          });
          await refresh();
          onClose();
          notify('Payment recorded.');
        }}
      >
        <p className="muted">
          Record a payment already made outside Orluma. This does not send money.
        </p>
        <Field label="Project">
          <select required value={selected} onChange={(e) => setSelected(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Description">
          <input name="title" required maxLength={200} autoFocus />
        </Field>
        <div className="form-grid">
          <Field label={'Amount / ' + (project?.currency || 'USD')}>
            <input name="amount" inputMode="decimal" required pattern="[0-9]+([.][0-9]{1,2})?" />
          </Field>
          <Field label="Payment date">
            <input name="paidOn" type="date" required defaultValue={today()} />
          </Field>
        </div>
        <Field label="Category">
          <select name="category" key={selected}>
            {[
              ...new Set([
                ...data.allocations.filter((a) => a.projectId === selected).map((a) => a.name),
                'Other',
              ]),
            ].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="Note or reference">
          <textarea name="note" maxLength={2000} rows={3} />
        </Field>
      </AsyncForm>
    </Dialog>
  );
}

export function ReasonDialog({
  title,
  label = 'Reason',
  submitLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  label?: string;
  submitLabel: string;
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
}) {
  return (
    <Dialog title={title} onClose={onClose}>
      <AsyncForm
        submitLabel={submitLabel}
        onCancel={onClose}
        danger
        onSubmit={async (form) => {
          await onConfirm(String(form.get('reason')).trim());
          onClose();
        }}
      >
        <Field label={label}>
          <textarea name="reason" required maxLength={2000} rows={4} autoFocus />
        </Field>
      </AsyncForm>
    </Dialog>
  );
}
