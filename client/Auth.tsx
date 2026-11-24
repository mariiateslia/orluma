import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import type { User } from './types';
import { Brand, AsyncForm, Field, ErrorMessage, Loading } from './ui';

type InviteInfo = { workspaceName: string; email: string; role: string; expiresAt: number };
export function Auth({
  onSignedIn,
  inviteToken,
  resetToken,
}: {
  onSignedIn: (user: User, workspaceId?: string) => void;
  inviteToken?: string;
  resetToken?: string;
}) {
  const [meta, setMeta] = useState<{ registrationOpen: boolean; firstAccount: boolean } | null>(
    null,
  );
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [mode, setMode] = useState<'signin' | 'signup' | 'forgot' | 'check' | 'reset'>(
    resetToken ? 'reset' : 'signin',
  );
  const [email, setEmail] = useState('');
  const [mailKind, setMailKind] = useState<'verification' | 'reset'>('verification');
  const [notice, setNotice] = useState(() =>
    new URLSearchParams(window.location.search).get('verified') === '1'
      ? 'Email confirmed. You can now sign in.'
      : '',
  );
  const callbackURL =
    window.location.origin + '/?verified=1' + (inviteToken ? '#/invite/' + inviteToken : '');
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
        if (!resetToken && !new URLSearchParams(window.location.search).has('verified'))
          setMode(value.firstAccount || inviteToken ? 'signup' : 'signin');
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
  }, [inviteToken, resetToken]);
  const register = mode === 'signup';
  const title = {
    signin: 'Good to have you back.',
    signup: 'Create your account.',
    forgot: 'A fresh way in.',
    check: 'Check your inbox.',
    reset: 'Choose a new password.',
  }[mode];
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
                {invite ? 'You’re invited to ' + invite.workspaceName : 'Welcome to Orluma'}
              </span>
              <h2>{title}</h2>
              <p className="muted">
                {mode === 'check'
                  ? `If ${email || 'this email'} has an eligible account, a link will arrive shortly. Check spam too. Links expire in one hour.`
                  : mode === 'forgot'
                    ? 'Enter your account email. We’ll send a link to reset your password.'
                    : mode === 'reset'
                      ? 'Your other sessions will be signed out after you reset your password.'
                      : invite
                        ? `Join as ${invite.role} with ${invite.email}.`
                        : register
                          ? 'Confirm your email to start a workspace for your team.'
                          : 'Sign in to pick up where your team left off.'}
              </p>
              {notice && (
                <p className="success-note" role="status">
                  {notice}
                </p>
              )}
              <ErrorMessage error={error} />
              {mode === 'check' ? (
                <>
                  <AsyncForm
                    submitLabel={
                      mailKind === 'reset' ? 'Send another reset link' : 'Resend confirmation email'
                    }
                    onSubmit={async () => {
                      if (mailKind === 'reset')
                        await api('/identity/request-password-reset', 'POST', {
                          email,
                          redirectTo: window.location.origin + '/reset-password',
                        });
                      else
                        await api('/identity/send-verification-email', 'POST', {
                          email,
                          callbackURL,
                        });
                      setNotice('If a link is needed, it will arrive shortly.');
                    }}
                  >
                    <p className="field-hint">
                      {mailKind === 'reset'
                        ? 'Use the latest reset email and keep this tab open.'
                        : 'Confirm your email, then come back to sign in.'}
                    </p>
                  </AsyncForm>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setMode('signin');
                      setNotice('');
                    }}
                  >
                    Back to sign in
                  </button>
                </>
              ) : (
                <AsyncForm
                  key={mode + String(inviteToken)}
                  submitLabel={
                    mode === 'forgot'
                      ? 'Send reset link'
                      : mode === 'reset'
                        ? 'Save new password'
                        : register
                          ? 'Create account'
                          : 'Sign in'
                  }
                  onSubmit={async (form) => {
                    const inputEmail = String(form.get('email') || email).trim();
                    setEmail(inputEmail);
                    setNotice('');
                    setError(null);
                    if (mode === 'forgot') {
                      await api('/identity/request-password-reset', 'POST', {
                        email: inputEmail,
                        redirectTo: window.location.origin + '/reset-password',
                      });
                      setMailKind('reset');
                      setMode('check');
                      return;
                    }
                    if (mode === 'reset') {
                      await api('/identity/reset-password', 'POST', {
                        token: resetToken,
                        newPassword: String(form.get('password')),
                      });
                      window.history.replaceState(null, '', '/');
                      setMode('signin');
                      setNotice('Password updated. Sign in with your new password.');
                      return;
                    }
                    if (register) {
                      setMailKind('verification');
                      await api(
                        '/identity/sign-up/email',
                        'POST',
                        {
                          email: inputEmail,
                          name: String(form.get('name')),
                          password: String(form.get('password')),
                          callbackURL,
                        },
                        undefined,
                        inviteToken ? { 'x-orluma-invitation': inviteToken } : undefined,
                      );
                      setMode('check');
                      return;
                    }
                    try {
                      const response = await api<{ user: User }>(
                        '/identity/sign-in/email',
                        'POST',
                        { email: inputEmail, password: String(form.get('password')) },
                      );
                      onSignedIn(response.user);
                    } catch (e) {
                      if (e instanceof ApiError && e.code === 'EMAIL_NOT_VERIFIED') {
                        setMailKind('verification');
                        setMode('check');
                        setNotice(
                          'Confirm your email before signing in. You can request a new link below.',
                        );
                      } else throw e;
                    }
                  }}
                >
                  {register && (
                    <Field label="Your name">
                      <input name="name" autoComplete="name" maxLength={80} required autoFocus />
                    </Field>
                  )}
                  {mode !== 'reset' && (
                    <Field label="Email">
                      <input
                        type="email"
                        name="email"
                        autoComplete="email"
                        defaultValue={invite?.email || email}
                        readOnly={Boolean(invite) && mode !== 'forgot'}
                        required
                        maxLength={254}
                        autoFocus={!register}
                      />
                    </Field>
                  )}
                  {mode !== 'forgot' && (
                    <Field
                      label={mode === 'reset' ? 'New password' : 'Password'}
                      hint={
                        register || mode === 'reset'
                          ? 'Use at least 12 characters. A passphrase works well.'
                          : undefined
                      }
                    >
                      <input
                        name="password"
                        type="password"
                        autoComplete={
                          register || mode === 'reset' ? 'new-password' : 'current-password'
                        }
                        required
                        minLength={register || mode === 'reset' ? 12 : 1}
                        maxLength={128}
                      />
                    </Field>
                  )}
                </AsyncForm>
              )}
              {mode === 'signin' && (
                <p className="auth-switch">
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setError(null);
                      setMode('forgot');
                    }}
                  >
                    Forgot password?
                  </button>
                </p>
              )}
              {(mode === 'signin' || register) && (meta?.registrationOpen || invite) && (
                <p className="auth-switch">
                  {register ? 'Already have an account?' : 'New here?'}{' '}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setError(null);
                      setMode(register ? 'signin' : 'signup');
                    }}
                  >
                    {register ? 'Sign in' : 'Create an account'}
                  </button>
                </p>
              )}
              {mode === 'forgot' && (
                <p className="auth-switch">
                  <button type="button" className="text-button" onClick={() => setMode('signin')}>
                    Back to sign in
                  </button>
                </p>
              )}
              {!meta?.registrationOpen && !invite && mode === 'signin' && (
                <p className="auth-switch muted">
                  New to this workspace? Ask your team for an invitation.
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
