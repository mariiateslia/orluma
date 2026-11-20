import { useEffect, useState } from 'react';
import { api } from './api';
import type { User } from './types';
import { Brand, AsyncForm, Field, ErrorMessage, Loading } from './ui';

type InviteInfo = { workspaceName: string; email: string; role: string; expiresAt: number };
export function Auth({
  onSignedIn,
  inviteToken,
}: {
  onSignedIn: (user: User, workspaceId?: string) => void;
  inviteToken?: string;
}) {
  const [meta, setMeta] = useState<{ registrationOpen: boolean; firstAccount: boolean } | null>(
    null,
  );
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [register, setRegister] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api<{ registrationOpen: boolean; firstAccount: boolean }>(
      '/meta',
      'GET',
      undefined,
      controller.signal,
    )
      .then((value) => {
        setMeta(value);
        setRegister(value.firstAccount || Boolean(inviteToken));
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e);
      });
    if (inviteToken)
      api<InviteInfo>(
        '/invitations/' + encodeURIComponent(inviteToken),
        'GET',
        undefined,
        controller.signal,
      )
        .then(setInvite)
        .catch((e) => {
          if (e.name !== 'AbortError') setError(e);
        });
    return () => controller.abort();
  }, [inviteToken]);
  return (
    <div className="auth-page">
      <section className="auth-art">
        <Brand />
        <div className="auth-art-copy">
          <span className="eyebrow">A shared place to move things forward.</span>
          <h1>
            Your work.
            <br />
            <span>In context.</span>
          </h1>
          <p>
            Projects, documents and spending.
            <br />
            Together, in a space your team owns.
          </p>
        </div>
        <span className="auth-art-caption">Orluma / Stone & Fog</span>
      </section>
      <section className="auth-form">
        <div className="auth-form-inner">
          {!meta && !error ? (
            <Loading />
          ) : (
            <>
              <span className="eyebrow">
                {invite
                  ? 'You’re invited to ' + invite.workspaceName
                  : meta?.firstAccount
                    ? 'Your space starts here'
                    : 'Welcome to Orluma'}
              </span>
              <h2>{register ? 'Create your account.' : 'Good to have you back.'}</h2>
              <p className="muted">
                {invite
                  ? `Join as ${invite.role} with ${invite.email}.`
                  : register
                    ? 'Start with a workspace for your team.'
                    : 'Sign in to pick up where your team left off.'}
              </p>
              <ErrorMessage error={error} />
              <AsyncForm
                key={String(register) + String(inviteToken)}
                submitLabel={
                  register ? (invite ? 'Create account & join' : 'Create account') : 'Sign in'
                }
                onSubmit={async (form) => {
                  const response = await api<{ user: User; workspaceId?: string }>(
                    '/auth/' + (register ? 'register' : 'login'),
                    'POST',
                    {
                      email: String(form.get('email')),
                      password: String(form.get('password')),
                      ...(register ? { name: String(form.get('name')), inviteToken } : {}),
                    },
                  );
                  onSignedIn(response.user, response.workspaceId);
                }}
              >
                {register && (
                  <Field label="Your name">
                    <input name="name" autoComplete="name" maxLength={80} required autoFocus />
                  </Field>
                )}
                <Field label="Email">
                  <input
                    type="email"
                    name="email"
                    autoComplete="email"
                    defaultValue={invite?.email || ''}
                    readOnly={Boolean(invite)}
                    required
                    maxLength={254}
                    autoFocus={!register}
                  />
                </Field>
                <Field
                  label="Password"
                  hint={
                    register ? 'Use at least 12 characters. A passphrase works well.' : undefined
                  }
                >
                  <input
                    name="password"
                    type="password"
                    autoComplete={register ? 'new-password' : 'current-password'}
                    required
                    minLength={register ? 12 : 1}
                    maxLength={128}
                  />
                </Field>
              </AsyncForm>
              {(meta?.registrationOpen || invite) && (
                <p className="auth-switch">
                  {register ? 'Already have an account?' : 'New here?'}{' '}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setRegister(!register)}
                  >
                    {register ? 'Sign in' : 'Create an account'}
                  </button>
                </p>
              )}
              {!meta?.registrationOpen && !invite && (
                <p className="auth-switch muted">
                  New to this workspace? Ask your team for an invitation link.
                </p>
              )}
              <p className="auth-footer">
                <a href="https://github.com/mariiateslia/orluma" target="_blank" rel="noreferrer">
                  Open-source. Yours to run.
                </a>
              </p>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

export function AcceptInvitation({
  token,
  user,
  onJoined,
  onLogout,
}: {
  token: string;
  user: User;
  onJoined: (workspaceId: string) => void;
  onLogout: () => void;
}) {
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const controller = new AbortController();
    api<InviteInfo>(
      '/invitations/' + encodeURIComponent(token),
      'GET',
      undefined,
      controller.signal,
    )
      .then(setInvite)
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e);
      });
    return () => controller.abort();
  }, [token]);
  return (
    <div className="onboarding">
      <Brand />
      <section className="onboarding-card">
        <h1>
          <span>A shared</span> space.
        </h1>
        <ErrorMessage error={error} />
        {!invite && !error ? (
          <Loading />
        ) : (
          invite && (
            <>
              <p>
                You’re invited to <strong>{invite.workspaceName}</strong> as {invite.role}.
              </p>
              {user.email.toLowerCase() === invite.email.toLowerCase() ? (
                <AsyncForm
                  submitLabel="Join workspace"
                  onSubmit={async () => {
                    const response = await api<{ workspaceId: string }>(
                      '/invitations/accept',
                      'POST',
                      { token },
                    );
                    onJoined(response.workspaceId);
                  }}
                >
                  <p className="muted">
                    Joining as {user.name} ({user.email}).
                  </p>
                </AsyncForm>
              ) : (
                <>
                  <p>
                    This invitation is for {invite.email}. You are signed in as {user.email}.
                  </p>
                  <button className="button primary" onClick={onLogout}>
                    Sign in with the invited email
                  </button>
                </>
              )}
            </>
          )
        )}
      </section>
    </div>
  );
}
