import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
  Children,
  cloneElement,
  isValidElement,
} from 'react';
import { Check, Circle, X, LoaderCircle, FileText, MessageCircle } from 'lucide-react';
import { api, dateLabel, initials } from './api';
import { useApp } from './context';
import type { RequestStatus, TaskStatus } from './types';

export function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark" aria-hidden="true" />
      <span>orluma</span>
    </span>
  );
}
export function Avatar({ name, dark = false }: { name: string; dark?: boolean }) {
  return (
    <span className={'avatar' + (dark ? ' dark' : '')} aria-label={name}>
      {initials(name)}
    </span>
  );
}
const labels: Record<string, string> = {
  pending: 'Awaiting approval',
  approved: 'Approved · reserved',
  paid: 'Paid · recorded',
  declined: 'Declined',
  cancelled: 'Cancelled',
  void: 'Voided',
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
  planned: 'Planned',
  active: 'In progress',
  paused: 'Paused',
};
export function Status({ status }: { status: RequestStatus | TaskStatus | string }) {
  return (
    <span className={'status status-' + status}>
      {status === 'done' || status === 'paid' ? (
        <Check aria-hidden="true" />
      ) : (
        <Circle aria-hidden="true" />
      )}
      {labels[status] || status}
    </span>
  );
}
export function Heading({
  muted,
  title,
  sub,
  actions,
}: {
  muted: string;
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>
          <span>{muted}</span> {title}
        </h1>
        {sub && <div className="heading-sub">{sub}</div>}
      </div>
      {actions && <div className="heading-actions">{actions}</div>}
    </div>
  );
}
export function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <section className="empty-state">
      <div className="emboss-icon">
        <FileText aria-hidden="true" />
      </div>
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </section>
  );
}
export function Loading({ text = 'Opening your workspace…' }: { text?: string }) {
  return (
    <div className="loading" role="status">
      <LoaderCircle aria-hidden="true" className="spinner" />
      <span>{text}</span>
    </div>
  );
}
export function ErrorMessage({ error }: { error: unknown }) {
  return error ? (
    <p className="form-error" role="alert">
      {error instanceof Error ? error.message : String(error)}
    </p>
  ) : null;
}
export function Dialog({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={'modal' + (wide ? ' modal-wide' : '')}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) {
          const box = ref.current.getBoundingClientRect();
          if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
          )
            onClose();
        }
      }}
    >
      <header className="modal-heading">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}>
          <X />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  const hintId = id + '-hint';
  const control = Children.map(children, (child) =>
    isValidElement<{ id?: string; 'aria-describedby'?: string }>(child)
      ? cloneElement(child, { id, 'aria-describedby': hint ? hintId : undefined })
      : child,
  );
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {control}
      {hint && <small id={hintId}>{hint}</small>}
    </div>
  );
}
export function AsyncForm({
  children,
  onSubmit,
  submitLabel = 'Save',
  onCancel,
  danger = false,
}: {
  children: ReactNode;
  onSubmit: (form: FormData) => Promise<void>;
  submitLabel?: string;
  onCancel?: () => void;
  danger?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await onSubmit(form);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit}>
      <fieldset disabled={busy}>
        {children}
        <ErrorMessage error={error} />
        <div className="form-actions">
          {onCancel && (
            <button type="button" className="button" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button
            type="submit"
            className={'button primary' + (danger ? ' danger' : '')}
            disabled={busy}
          >
            {busy ? (
              <>
                <LoaderCircle className="spinner" />
                Saving…
              </>
            ) : (
              submitLabel
            )}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
export function Comments({ type, id }: { type: 'task' | 'document' | 'request'; id: string }) {
  const { data, canEdit, refresh } = useApp();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const comments = data.comments.filter(
    (comment) => comment.entityType === type && comment.entityId === id,
  );
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/workspaces/${data.workspace.id}/comments`, 'POST', {
        entityType: type,
        entityId: id,
        body: body.trim(),
      });
      setBody('');
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="comments">
      <div className="section-heading">
        <h2>
          <MessageCircle aria-hidden="true" />
          Discussion
        </h2>
        <span className="metadata">
          {comments.length} {comments.length === 1 ? 'comment' : 'comments'}
        </span>
      </div>
      {comments.map((comment) => (
        <article className="comment" key={comment.id}>
          <Avatar
            name={
              data.members.find((person) => person.id === comment.authorId)?.name || 'Former member'
            }
          />
          <div>
            <header>
              <strong>
                {data.members.find((person) => person.id === comment.authorId)?.name ||
                  'Former member'}
              </strong>
              <time>{dateLabel(comment.createdAt)}</time>
            </header>
            <p>{comment.body}</p>
          </div>
        </article>
      ))}
      {!comments.length && (
        <p className="muted">Keep decisions and questions attached to the work.</p>
      )}
      {canEdit && (
        <form onSubmit={submit}>
          <Field label="Add a comment">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={5000}
              required
              rows={3}
            />
          </Field>
          <ErrorMessage error={error} />
          <button className="button" disabled={busy || !body.trim()}>
            {busy ? 'Posting…' : 'Post comment'}
          </button>
        </form>
      )}
    </section>
  );
}
