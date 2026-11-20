import { useState } from 'react';
import {
  Check,
  CheckCheck,
  Receipt,
  Plus,
  Users,
  FileText,
  CircleCheck,
  Pencil,
} from 'lucide-react';
import { api, dateLabel, money, today } from './api';
import { useApp } from './context';
import {
  Heading,
  Status,
  Avatar,
  Empty,
  Comments,
  Dialog,
  AsyncForm,
  Field,
  ErrorMessage,
} from './ui';
import { ExpenseDialog, ProjectDialog, RequestDialog, ReasonDialog } from './forms';
import { ProjectTabs } from './Work';
import type { Project, SpendRequest, Expense } from './types';

export function RequestCard({ project }: { project?: Project }) {
  const { data, user, admin, go, canEdit } = useApp();
  const [create, setCreate] = useState(false);
  const requests = data.requests.filter(
    (r) => (!project || r.projectId === project.id) && r.status === 'pending',
  );
  const needsMe = requests.filter(
    (r) => r.approverId === user.id && admin && r.requesterId !== user.id,
  );
  const request = needsMe[0] || requests.find((r) => r.requesterId === user.id);
  if (!request)
    return (
      <section className="inset approval-card">
        <div className="section-heading">
          <h2>A little breathing room</h2>
          <span className="emboss-icon small">
            <Check />
          </span>
        </div>
        <p>No requests waiting for your decision.</p>
        {canEdit && data.projects.some((p) => !p.archived) && (
          <button className="button" onClick={() => setCreate(true)}>
            Request spending
          </button>
        )}
        {create && <RequestDialog projectId={project?.id} onClose={() => setCreate(false)} />}
      </section>
    );
  const owner = data.members.find((m) => m.id === request.requesterId);
  const currentProject = data.projects.find((p) => p.id === request.projectId)!;
  return (
    <section className="inset approval-card">
      <div className="section-heading">
        <h2>{needsMe.length ? 'Needs your decision' : 'Awaiting approval'}</h2>
        <span className="count-circle">
          {needsMe.length || requests.filter((r) => r.requesterId === user.id).length}
        </span>
      </div>
      <div>
        <h3 className="approval-title">{request.title}</h3>
        <div className="request-amount">{money(request.amountCents, currentProject.currency)}</div>
      </div>
      <div className="person-line">
        <Avatar name={owner?.name || 'Former member'} />
        <div>
          Requested by {owner?.name || 'Former member'}
          <small>{currentProject.name}</small>
        </div>
      </div>
      <p>{request.reason.length > 125 ? request.reason.slice(0, 122) + '…' : request.reason}</p>
      <button
        className="button primary"
        onClick={() => go(`/w/${data.workspace.id}/requests/${request.id}`)}
      >
        {needsMe.length ? 'Review request' : 'View request'}
      </button>
    </section>
  );
}

function AllocationMap({ project }: { project: Project }) {
  const { data } = useApp();
  const [selected, setSelected] = useState('');
  const allocations = data.allocations.filter(
    (a) => a.projectId === project.id && a.amountCents > 0,
  );
  const maximum = Math.max(...allocations.map((a) => a.amountCents), 1);
  const active = allocations.find((a) => a.id === selected) || allocations[0];
  if (!allocations.length)
    return (
      <section className="allocation-map">
        <Empty
          title="Give the budget some shape"
          body="Add category allocations from Edit budget. Exact amounts stay visible alongside the map."
        />
      </section>
    );
  return (
    <section className="allocation-map">
      <div className="allocation-grid" aria-label="Budget allocations">
        {allocations.map((allocation) => (
          <div className="allocation-cell" key={allocation.id}>
            <button
              className="allocation-pebble"
              style={
                { '--size': Math.sqrt(allocation.amountCents / maximum) } as React.CSSProperties
              }
              aria-pressed={active.id === allocation.id}
              aria-label={
                allocation.name +
                ', ' +
                money(allocation.amountCents, project.currency) +
                ' allocated'
              }
              onClick={() => setSelected(allocation.id)}
            >
              {money(allocation.amountCents, project.currency)}
            </button>
            <span>{allocation.name}</span>
          </div>
        ))}
      </div>
      <div className="allocation-detail" aria-live="polite">
        <strong>
          {active.name} / {money(active.amountCents, project.currency)} allocated
        </strong>
        <span>
          Spent:{' '}
          {money(
            data.expenses
              .filter(
                (e) =>
                  e.projectId === project.id && e.category === active.name && e.status === 'active',
              )
              .reduce((sum, e) => sum + e.amountCents, 0),
            project.currency,
          )}{' '}
          / Reserved:{' '}
          {money(
            data.requests
              .filter(
                (r) =>
                  r.projectId === project.id &&
                  r.category === active.name &&
                  r.status === 'approved',
              )
              .reduce((sum, r) => sum + r.amountCents, 0),
            project.currency,
          )}
        </span>
      </div>
      {project.budgetCents > allocations.reduce((sum, a) => sum + a.amountCents, 0) && (
        <p className="metadata">
          Unallocated:{' '}
          {money(
            project.budgetCents - allocations.reduce((sum, a) => sum + a.amountCents, 0),
            project.currency,
          )}
        </p>
      )}
    </section>
  );
}

export function SpendingLedger({ project }: { project?: Project }) {
  const { data, user, go } = useApp();
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [count, setCount] = useState(40);
  const requests = data.requests.filter(
    (r) => (!project || r.projectId === project.id) && !['paid', 'void'].includes(r.status),
  );
  const expenses = data.expenses.filter((e) => !project || e.projectId === project.id);
  const entries = [
    ...requests.map((r) => ({
      id: r.id,
      title: r.title,
      category: r.category,
      amount: r.amountCents,
      projectId: r.projectId,
      status: r.status,
      date: r.createdAt,
      type: 'request',
      requestId: r.id,
      person: r.requesterId,
    })),
    ...expenses.map((e) => ({
      id: e.id,
      title: e.title,
      category: e.category,
      amount: e.amountCents,
      projectId: e.projectId,
      status: e.status === 'active' ? 'paid' : 'void',
      date: e.createdAt,
      type: 'expense',
      requestId: e.requestId,
      person: e.createdBy,
    })),
  ]
    .filter(
      (entry) =>
        (filter === 'all' ||
          (filter === 'mine' && entry.person === user.id) ||
          entry.status === filter) &&
        (!search ||
          entry.title.toLowerCase().includes(search.toLowerCase()) ||
          entry.category.toLowerCase().includes(search.toLowerCase())),
    )
    .sort((a, b) => b.date.localeCompare(a.date));
  return (
    <section className="ledger">
      <div className="section-heading">
        <h2>Requests & expenses</h2>
        <span className="metadata">{entries.length} records</span>
      </div>
      <div className="list-toolbar">
        <div className="view-switch" role="group" aria-label="Spending status">
          {[
            ['all', 'All'],
            ['pending', 'Pending'],
            ['approved', 'Reserved'],
            ['paid', 'Paid'],
            ['mine', 'Mine'],
          ].map(([value, label]) => (
            <button
              key={value}
              aria-pressed={filter === value}
              onClick={() => {
                setFilter(value);
                setCount(40);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="search-field">
          <span className="sr-only">Search spending</span>
          <input
            type="search"
            placeholder="Search spending"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setCount(40);
            }}
          />
        </label>
      </div>
      {entries.slice(0, count).map((entry) => {
        const currentProject = data.projects.find((p) => p.id === entry.projectId)!;
        return (
          <div className="work-row" key={entry.type + entry.id}>
            <div className="row-main">
              <span className="emboss-icon small">
                <Receipt />
              </span>
              <div>
                <button
                  className="text-button row-title"
                  onClick={() =>
                    go(
                      `/w/${data.workspace.id}/${entry.requestId ? 'requests' : 'expenses'}/${entry.requestId || entry.id}`,
                    )
                  }
                >
                  {entry.title}
                </button>
                <div className="row-meta">
                  {entry.category}
                  <span>{project ? dateLabel(entry.date) : currentProject.name}</span>
                </div>
              </div>
            </div>
            <div className="row-end">
              <Status status={entry.status} />
              <strong className="ledger-amount">
                {money(entry.amount, currentProject.currency)}
              </strong>
            </div>
          </div>
        );
      })}
      {!entries.length && <p className="muted empty-inline">No records in this view.</p>}
      {entries.length > count && (
        <button className="button" onClick={() => setCount(count + 40)}>
          Show more
        </button>
      )}
    </section>
  );
}

export function BudgetPage({ project }: { project: Project }) {
  const { admin, canEdit } = useApp();
  const [map, setMap] = useState(false);
  const [request, setRequest] = useState(false);
  const [expense, setExpense] = useState(false);
  const [edit, setEdit] = useState(false);
  const budget = project.budget;
  return (
    <>
      <Heading
        muted="Project"
        title="budget"
        sub={project.name + ' / ' + project.currency}
        actions={
          <>
            {admin && !project.archived && (
              <button className="button" onClick={() => setEdit(true)}>
                <Pencil />
                Edit budget
              </button>
            )}
            {canEdit && !project.archived && (
              <div className="action-pair">
                <button
                  className="button round embossed"
                  aria-label="New spending request"
                  onClick={() => setRequest(true)}
                >
                  <Plus />
                </button>
                <button className="button primary" onClick={() => setRequest(true)}>
                  Request spend
                </button>
              </div>
            )}
          </>
        }
      />
      <ProjectTabs project={project} active="budget" />
      <div className="view-switch budget-mode" role="group" aria-label="Budget view">
        <button aria-pressed={!map} onClick={() => setMap(false)}>
          Summary
        </button>
        <button aria-pressed={map} onClick={() => setMap(true)}>
          Allocation map
        </button>
      </div>
      {budget.available < 0 && (
        <div className="notice warning">
          Recorded spending exceeds this budget by {money(-budget.available, project.currency)}.
        </div>
      )}
      <div className="balance-grid">
        {map ? (
          <AllocationMap project={project} />
        ) : (
          <section className="balance">
            <div className="pebble-stage">
              <span className="pebble-annotation">
                ({project.currency} / {project.id.slice(0, 6).toUpperCase()})
              </span>
              <div className="money-pebble">
                <div className="money-core">
                  <span className="eyebrow">Available to commit</span>
                  <div
                    className={'big-money' + (budget.available < 0 ? ' negative' : '')}
                    style={
                      {
                        '--money-fit':
                          Math.min(20, 122 / money(budget.available, project.currency).length) +
                          'cqi',
                      } as React.CSSProperties
                    }
                  >
                    {money(budget.available, project.currency)}
                  </div>
                  <span className="metadata">
                    of {money(budget.allocated, project.currency)} project budget
                  </span>
                </div>
              </div>
            </div>
            <div className="budget-numbers">
              {[
                ['Allocated', budget.allocated],
                ['Spent', budget.spent],
                ['Reserved', budget.reserved],
              ].map(([label, value]) => (
                <div key={label}>
                  <span className="eyebrow">{label}</span>
                  <strong>{money(Number(value), project.currency)}</strong>
                </div>
              ))}
            </div>
          </section>
        )}
        <RequestCard project={project} />
      </div>
      <SpendingLedger project={project} />
      <div className="budget-footer">
        <p className="metadata">
          Available = allocated − spent − reserved. Pending requests do not reserve funds.
        </p>
        {admin && !project.archived && (
          <button className="text-button" onClick={() => setExpense(true)}>
            Record an external payment
          </button>
        )}
      </div>
      {request && <RequestDialog projectId={project.id} onClose={() => setRequest(false)} />}
      {expense && <ExpenseDialog projectId={project.id} onClose={() => setExpense(false)} />}
      {edit && <ProjectDialog project={project} onClose={() => setEdit(false)} />}
    </>
  );
}

export function SpendingPage() {
  const { data, go, canEdit, admin } = useApp();
  const [request, setRequest] = useState(false);
  const [expense, setExpense] = useState(false);
  const projects = data.projects.filter((p) => !p.archived);
  return (
    <>
      <Heading
        muted="Team"
        title="spending"
        sub="The work and context behind every decision."
        actions={
          <>
            {admin && projects.length > 0 && (
              <button className="button" onClick={() => setExpense(true)}>
                Record payment
              </button>
            )}
            {canEdit && projects.length > 0 && (
              <button className="button primary" onClick={() => setRequest(true)}>
                <Plus />
                Request spend
              </button>
            )}
          </>
        }
      />
      {projects.length ? (
        <>
          <div className="spending-projects">
            {projects.map((project) => (
              <button
                className="inset spending-project"
                key={project.id}
                onClick={() => go(`/w/${data.workspace.id}/projects/${project.id}/budget`)}
              >
                <span className="eyebrow">{project.name}</span>
                <strong>{money(project.budget.available, project.currency)}</strong>
                <span>Available / {project.currency}</span>
              </button>
            ))}
          </div>
          <SpendingLedger />
        </>
      ) : (
        <Empty
          title="A place for every expense"
          body="Create a project to start planning budgets and requesting spending."
        />
      )}
      {request && <RequestDialog onClose={() => setRequest(false)} />}
      {expense && <ExpenseDialog onClose={() => setExpense(false)} />}
    </>
  );
}

export function RequestDetail({ request }: { request: SpendRequest }) {
  const { data, user, admin, canEdit, go, refresh, notify } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [decline, setDecline] = useState(false);
  const [pay, setPay] = useState(false);
  const project = data.projects.find((p) => p.id === request.projectId)!;
  const requester = data.members.find((m) => m.id === request.requesterId);
  const approver = data.members.find((m) => m.id === request.approverId);
  const task = data.tasks.find((t) => t.id === request.taskId);
  const documents = data.documents.filter((d) => d.projectId === project.id && !d.archived);
  const canReview =
    canEdit &&
    admin &&
    request.approverId === user.id &&
    request.requesterId !== user.id &&
    request.status === 'pending';
  async function action(type: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError(null);
    try {
      await api('/requests/' + request.id + '/action', 'POST', {
        action: type,
        version: request.version,
        ...extra,
      });
      await refresh();
      notify(
        type === 'pay'
          ? 'Payment recorded.'
          : type === 'approve'
            ? 'Spending approved and reserved.'
            : type === 'decline'
              ? 'Request declined.'
              : 'Request cancelled.',
      );
    } catch (e) {
      setError(e);
      await refresh().catch(() => {});
      throw e;
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Heading
        muted="Spend"
        title="request"
        sub={project.name + ' / ' + request.id.slice(0, 8).toUpperCase()}
        actions={
          <button
            className="button"
            onClick={() => go(`/w/${data.workspace.id}/projects/${project.id}/budget`)}
          >
            Back to budget
          </button>
        }
      />
      <div className="detail-grid">
        <section>
          <div className="emboss-icon">
            {request.status === 'paid' ? (
              <CheckCheck />
            ) : request.status === 'approved' ? (
              <Check />
            ) : (
              <Receipt />
            )}
          </div>
          <Status status={request.status} />
          <div className="detail-money">{money(request.amountCents, project.currency)}</div>
          <h2 className="detail-title">{request.title}</h2>
          <p className="preserve-lines muted">{request.reason}</p>
          <section className="related-section">
            <h2>Linked context</h2>
            {task && (
              <button
                className="context-link"
                onClick={() => go(`/w/${data.workspace.id}/tasks/${task.id}`)}
              >
                <CircleCheck />
                {task.title}
              </button>
            )}
            {documents.map((document) => (
              <button
                className="context-link"
                key={document.id}
                onClick={() => go(`/w/${data.workspace.id}/documents/${document.id}`)}
              >
                <FileText />
                {document.title}
              </button>
            ))}
          </section>
        </section>
        <section className="inset">
          <h2>Request details</h2>
          <div className="property">
            <span>Requested by</span>
            <div>
              {requester ? (
                <>
                  <Avatar name={requester.name} />
                  {requester.name}
                </>
              ) : (
                'Former member'
              )}
            </div>
          </div>
          <div className="property">
            <span>Approver</span>
            <div>
              {approver ? (
                <>
                  <Avatar name={approver.name} />
                  {approver.name}
                </>
              ) : (
                'Former member'
              )}
            </div>
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
            <span>Category</span>
            <div>{request.category}</div>
          </div>
          <div className="property">
            <span>Currency</span>
            <div>{project.currency}</div>
          </div>
          {request.status === 'pending' && (
            <section className="decision-section">
              <h2>Budget impact</h2>
              <div className="property">
                <span>Available now</span>
                <div>{money(project.budget.available, project.currency)}</div>
              </div>
              <div className="property">
                <span>After approval</span>
                <div>{money(project.budget.available - request.amountCents, project.currency)}</div>
              </div>
              {canReview ? (
                <>
                  <div className="form-actions">
                    <button
                      className="button primary"
                      disabled={
                        busy ||
                        request.amountCents > project.budget.available ||
                        Boolean(project.archived)
                      }
                      onClick={() => {
                        void action('approve').catch(() => {});
                      }}
                    >
                      <Check />
                      Approve {money(request.amountCents, project.currency)}
                    </button>
                    <button className="button" disabled={busy} onClick={() => setDecline(true)}>
                      Decline
                    </button>
                  </div>
                  {request.amountCents > project.budget.available && (
                    <p className="form-error">This request exceeds the available project budget.</p>
                  )}
                </>
              ) : (
                <p className="muted">
                  Waiting for {approver?.name || 'the assigned approver'}.{' '}
                  {request.requesterId === user.id ? 'You cannot approve your own request.' : ''}
                </p>
              )}
              <p className="metadata">Approval reserves budget. It does not send a payment.</p>
            </section>
          )}
          {request.status === 'approved' && (
            <section className="decision-section">
              <p className="success-note">
                <Check />
                {money(request.amountCents, project.currency)} reserved in this budget.
              </p>
              {canEdit && (admin || request.requesterId === user.id) && (
                <button className="button primary" onClick={() => setPay(true)}>
                  <CheckCheck />
                  Record as paid
                </button>
              )}
              <p className="metadata">Record this after paying outside Orluma.</p>
            </section>
          )}
          {request.status === 'declined' && (
            <section className="decision-section">
              <h2>Reason for declining</h2>
              <p className="preserve-lines muted">{request.declineReason}</p>
            </section>
          )}
          {request.status === 'paid' && (
            <p className="success-note">
              <CheckCheck />
              Payment recorded {dateLabel(request.paidAt)}. Reserved funds moved to spent.
            </p>
          )}
          {['pending', 'approved'].includes(request.status) &&
            canEdit &&
            (admin || (request.requesterId === user.id && request.status === 'pending')) && (
              <button
                className="text-button danger-text section-link"
                disabled={busy}
                onClick={() => {
                  if (window.confirm('Cancel this request? Any reserved budget will be released.'))
                    void action('cancel').catch(() => {});
                }}
              >
                Cancel request
              </button>
            )}
          <ErrorMessage error={error} />
        </section>
      </div>
      <Comments type="request" id={request.id} />
      {decline && (
        <ReasonDialog
          title="Decline spending request"
          submitLabel="Decline request"
          onClose={() => setDecline(false)}
          onConfirm={async (reason) => {
            await action('decline', { reason });
          }}
        />
      )}
      {pay && (
        <Dialog title="Record the payment" onClose={() => setPay(false)}>
          <AsyncForm
            submitLabel="Record as paid"
            onCancel={() => setPay(false)}
            onSubmit={async (form) => {
              await action('pay', {
                paidOn: String(form.get('paidOn')),
                note: String(form.get('note')),
              });
              setPay(false);
            }}
          >
            <p className="muted">
              Record {money(request.amountCents, project.currency)} paid outside Orluma. This does
              not transfer money.
            </p>
            <Field label="Payment date">
              <input type="date" name="paidOn" defaultValue={today()} required />
            </Field>
            <Field label="Note or payment reference">
              <textarea name="note" rows={3} maxLength={2000} />
            </Field>
          </AsyncForm>
        </Dialog>
      )}
    </>
  );
}

export function ExpenseDetail({ expense }: { expense: Expense }) {
  const { data, admin, go, refresh, notify } = useApp();
  const [voiding, setVoiding] = useState(false);
  const project = data.projects.find((p) => p.id === expense.projectId)!;
  const creator = data.members.find((m) => m.id === expense.createdBy);
  return (
    <>
      <Heading
        muted="Recorded"
        title="payment"
        sub={project.name}
        actions={
          <button
            className="button"
            onClick={() => go(`/w/${data.workspace.id}/projects/${project.id}/budget`)}
          >
            Back to budget
          </button>
        }
      />
      <div className="detail-grid">
        <section>
          <div className="emboss-icon">
            <Receipt />
          </div>
          <Status status={expense.status === 'active' ? 'paid' : 'void'} />
          <div className="detail-money">{money(expense.amountCents, project.currency)}</div>
          <h2 className="detail-title">{expense.title}</h2>
          <p className="preserve-lines muted">{expense.note || 'Payment recorded manually.'}</p>
          {expense.voidReason && <p className="notice">Voided: {expense.voidReason}</p>}
        </section>
        <section className="inset">
          <h2>Payment details</h2>
          {[
            ['Payment date', dateLabel(expense.paidOn)],
            ['Category', expense.category],
            ['Recorded by', creator?.name || 'Former member'],
            ['Currency', project.currency],
          ].map(([label, value]) => (
            <div className="property" key={label}>
              <span>{label}</span>
              <div>{value}</div>
            </div>
          ))}
          {admin && expense.status === 'active' && (
            <button className="button section-link" onClick={() => setVoiding(true)}>
              Void this record
            </button>
          )}
          <p className="metadata">
            Voiding keeps the history and removes this record from spent totals. It does not refund
            a payment.
          </p>
        </section>
      </div>
      {voiding && (
        <ReasonDialog
          title="Void a payment record"
          submitLabel="Void record"
          onClose={() => setVoiding(false)}
          onConfirm={async (reason) => {
            await api('/expenses/' + expense.id + '/void', 'POST', { reason });
            await refresh();
            notify('Payment record voided.');
          }}
        />
      )}
    </>
  );
}
