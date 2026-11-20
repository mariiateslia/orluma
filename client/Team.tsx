import { useEffect, useState } from 'react';
import { UserPlus, Copy, Check, Download, Plus } from 'lucide-react';
import { api, dateLabel } from './api';
import { useApp } from './context';
import { Heading, Avatar, Dialog, AsyncForm, Field, ErrorMessage } from './ui';
import type { Invitation, Member, Role } from './types';

function InviteDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { data } = useApp();
  const [url, setUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  return (
    <Dialog title="Invite a teammate" onClose={onClose}>
      {url ? (
        <div className="invite-result">
          <p className="success-note">
            <Check />
            Invitation ready.
          </p>
          <Field
            label="Invitation link"
            hint="Share this link with the invited person. It expires in seven days and can be used once."
          >
            <input value={url} readOnly onFocus={(e) => e.currentTarget.select()} />
          </Field>
          <button
            className="button primary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(url);
                setCopied(true);
                setCopyError(false);
              } catch {
                setCopyError(true);
              }
            }}
          >
            <Copy />
            {copied ? 'Copied' : 'Copy invitation link'}
          </button>
          {copyError && <p className="muted">Select the link above and copy it manually.</p>}
          <button className="button" onClick={onClose}>
            Done
          </button>
        </div>
      ) : (
        <AsyncForm
          submitLabel="Create invitation link"
          onCancel={onClose}
          onSubmit={async (form) => {
            const response = await api<{ inviteUrl: string }>(
              `/workspaces/${data.workspace.id}/invitations`,
              'POST',
              { email: String(form.get('email')), role: String(form.get('role')) },
            );
            setUrl(response.inviteUrl);
            onCreated();
          }}
        >
          <Field label="Teammate’s email">
            <input type="email" name="email" required maxLength={254} autoFocus />
          </Field>
          <Field label="Workspace role">
            <select name="role" defaultValue="member">
              <option value="member">Member — tasks, docs and requests</option>
              <option value="viewer">Viewer — read-only access</option>
              {data.workspace.role === 'owner' && (
                <option value="admin">Admin — budgets and approvals</option>
              )}
            </select>
          </Field>
          <p className="field-hint">
            Orluma creates a link for you to share. It does not send an email.
          </p>
        </AsyncForm>
      )}
    </Dialog>
  );
}
export function TeamPage() {
  const { data, user, admin, refresh, notify, go } = useApp();
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [error, setError] = useState<unknown>(null);
  const workspaceId = data.workspace.id;
  const activity = data.activity[0]?.id;
  async function loadInvitations() {
    if (!admin) return;
    try {
      const response = await api<{ invitations: Invitation[] }>(
        `/workspaces/${workspaceId}/invitations`,
      );
      setInvitations(response.invitations);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }
  useEffect(() => {
    void loadInvitations();
  }, [workspaceId, admin, activity]);
  async function remove(member: Member) {
    if (
      !window.confirm(
        'Remove ' + member.name + ' from this workspace? They will lose access immediately.',
      )
    )
      return;
    try {
      await api(`/workspaces/${workspaceId}/members/${member.id}`, 'DELETE', {});
      await refresh();
      notify('Member removed.');
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  return (
    <>
      <Heading
        muted="Small"
        title="team"
        sub={data.workspace.name + ' / ' + data.members.length + ' people'}
        actions={
          admin && (
            <button className="button primary" onClick={() => setInviting(true)}>
              <UserPlus />
              Invite teammate
            </button>
          )
        }
      />
      <div className="member-list">
        {data.members.map((member) => (
          <div className="work-row" key={member.id}>
            <div className="row-main">
              <Avatar name={member.name} />
              <div>
                <span className="row-title">
                  {member.name}
                  {member.id === user.id ? ' (you)' : ''}
                </span>
                <div className="row-meta">{member.email}</div>
              </div>
            </div>
            <div className="row-end">
              <span className="role-label">{member.role}</span>
              {data.workspace.role === 'owner' && (
                <>
                  <button className="text-button" onClick={() => setEditing(member)}>
                    Change role
                  </button>
                  {member.id !== user.id && (
                    <button
                      className="text-button danger-text"
                      onClick={() => {
                        void remove(member);
                      }}
                    >
                      Remove
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
      </div>
      <section className="role-guide">
        <h2>Space to work, clear responsibilities.</h2>
        <p>
          Members work on projects, tasks and documents. Admins also manage budgets and review
          assigned spending requests. Viewers can read the workspace. Owners manage roles and
          ownership.
        </p>
        <p>Every spending request needs another owner or admin to review it.</p>
      </section>
      {admin && (
        <section className="invitations">
          <div className="section-heading">
            <h2>Invitations</h2>
            <button
              className="text-button"
              onClick={() => {
                void loadInvitations();
              }}
            >
              Refresh invitations
            </button>
          </div>
          <ErrorMessage error={error} />
          {invitations
            .filter((i) => !i.usedAt && i.expiresAt > Date.now())
            .map((invitation) => (
              <div className="work-row" key={invitation.id}>
                <div>
                  <span>{invitation.email}</span>
                  <div className="row-meta">
                    {invitation.role} / Expires{' '}
                    {dateLabel(new Date(invitation.expiresAt).toISOString())}
                  </div>
                </div>
                <button
                  className="text-button danger-text"
                  onClick={async () => {
                    try {
                      await api(
                        `/workspaces/${workspaceId}/invitations/${invitation.id}`,
                        'DELETE',
                        {},
                      );
                      await loadInvitations();
                      notify('Invitation revoked.');
                    } catch (e) {
                      notify((e as Error).message, true);
                    }
                  }}
                >
                  Revoke
                </button>
              </div>
            ))}
          {!invitations.some((i) => !i.usedAt && i.expiresAt > Date.now()) && (
            <p className="muted">No open invitations.</p>
          )}
        </section>
      )}
      {inviting && (
        <InviteDialog
          onClose={() => setInviting(false)}
          onCreated={() => {
            void loadInvitations();
          }}
        />
      )}
      {editing && (
        <Dialog title={'Change ' + editing.name + '’s role'} onClose={() => setEditing(null)}>
          <AsyncForm
            submitLabel="Save role"
            onCancel={() => setEditing(null)}
            onSubmit={async (form) => {
              const role = String(form.get('role')) as Role;
              await api(`/workspaces/${workspaceId}/members/${editing.id}`, 'PATCH', { role });
              await refresh();
              setEditing(null);
              notify('Role updated.');
            }}
          >
            <Field label="Workspace role">
              <select name="role" defaultValue={editing.role}>
                <option value="owner">Owner</option>
                <option value="admin">Admin</option>
                <option value="member">Member</option>
                <option value="viewer">Viewer</option>
              </select>
            </Field>
            <p className="muted">Keep at least one owner. Only owners can change roles.</p>
          </AsyncForm>
        </Dialog>
      )}
    </>
  );
}

export function SettingsPage() {
  const { user, data, workspaces, admin, newWorkspace, refreshWorkspaces, notify, go } = useApp();
  async function leave() {
    if (
      !window.confirm(
        'Leave ' + data.workspace.name + '? You will need another invitation to return.',
      )
    )
      return;
    try {
      await api(`/workspaces/${data.workspace.id}/members/${user.id}`, 'DELETE', {});
      await refreshWorkspaces();
      go('/');
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  return (
    <>
      <Heading muted="Your" title="settings" sub="Your account and the space you share." />
      <div className="settings-grid">
        <section>
          <h2>Account</h2>
          <div className="property">
            <span>Name</span>
            <div>{user.name}</div>
          </div>
          <div className="property">
            <span>Email</span>
            <div>{user.email}</div>
          </div>
          <section className="settings-section">
            <h2>Change password</h2>
            <AsyncForm
              submitLabel="Update password"
              onSubmit={async (form) => {
                const password = String(form.get('password'));
                if (password !== String(form.get('confirm')))
                  throw new Error('The new passwords do not match.');
                await api('/auth/password', 'POST', {
                  currentPassword: String(form.get('current')),
                  newPassword: password,
                });
                notify('Password updated. Other sessions have been signed out.');
              }}
            >
              <Field label="Current password">
                <input
                  type="password"
                  name="current"
                  autoComplete="current-password"
                  required
                  maxLength={128}
                />
              </Field>
              <Field label="New password" hint="At least 12 characters.">
                <input
                  type="password"
                  name="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={128}
                />
              </Field>
              <Field label="Confirm new password">
                <input
                  type="password"
                  name="confirm"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={128}
                />
              </Field>
            </AsyncForm>
          </section>
        </section>
        <div className="stack">
          <section className="inset">
            <h2>Workspace</h2>
            <Field label="Switch workspace">
              <select value={data.workspace.id} onChange={(e) => go(`/w/${e.target.value}/home`)}>
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </Field>
            <div className="property">
              <span>Name</span>
              <div>{data.workspace.name}</div>
            </div>
            <div className="property">
              <span>Your role</span>
              <div>{data.workspace.role}</div>
            </div>
            {admin && (
              <a className="button" href={`/api/workspaces/${data.workspace.id}/export`} download>
                <Download />
                Export workspace data
              </a>
            )}
            <button className="button section-link" onClick={newWorkspace}>
              <Plus />
              Create another workspace
            </button>
            <button
              className="text-button danger-text section-link"
              onClick={() => {
                void leave();
              }}
            >
              Leave this workspace
            </button>
          </section>
          <section className="inset">
            <h2>A space your team owns.</h2>
            <p>
              Orluma is open source. You can inspect the code, host your own copy and make it your
              own.
            </p>
            <a
              className="button"
              href="https://github.com/mariiateslia/orluma"
              target="_blank"
              rel="noreferrer"
            >
              Source on GitHub
            </a>
            <p className="metadata section-link">Version 0.1.0</p>
          </section>
        </div>
      </div>
    </>
  );
}
