import { betterAuth } from 'better-auth';
import { createAuthMiddleware, APIError } from 'better-auth/api';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { randomUUID } from 'node:crypto';
import { registerInput } from './validation.js';
import { checkPassword, digest } from './security.js';

export function authOptions({
  db,
  appUrl,
  secret,
  mail,
  registrationMode = 'invite',
  bootstrapEmail = '',
  development = false,
  disableRateLimit = false,
}) {
  if (!secret || secret.length < 32)
    throw new Error('AUTH_SECRET must contain at least 32 random characters.');
  return {
    appName: 'Orluma',
    baseURL: appUrl,
    basePath: '/api/identity',
    secret,
    database: db.pool,
    trustedOrigins: [
      appUrl,
      ...(development ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : []),
    ],
    advanced: { cookiePrefix: 'orluma', database: { generateId: () => randomUUID() } },
    user: {
      modelName: 'users',
      fields: { emailVerified: 'email_verified', createdAt: 'created_at', updatedAt: 'updated_at' },
    },
    session: {
      modelName: 'auth_sessions',
      fields: {
        userId: 'user_id',
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
      },
      expiresIn: 7 * 86400,
      cookieCache: { enabled: false },
    },
    account: {
      modelName: 'auth_accounts',
      fields: {
        accountId: 'account_id',
        providerId: 'provider_id',
        userId: 'user_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    verification: {
      modelName: 'auth_verifications',
      fields: { expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at' },
    },
    rateLimit: { enabled: !disableRateLimit, storage: 'database', modelName: 'auth_rate_limits' },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 3600,
      password: {
        hash: hashPassword,
        verify: ({ hash, password }) =>
          hash.startsWith('scrypt:')
            ? checkPassword(password, hash)
            : verifyPassword({ hash, password }),
      },
      sendResetPassword: async ({ user, url }) =>
        mail.enqueue({
          to: user.email,
          subject: 'Reset your Orluma password',
          text: `Someone requested a password reset for your Orluma account.\n\nChoose a new password:\n${url}\n\nThis link expires in one hour and can be used once. If you did not request it, you can ignore this email.`,
        }),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      expiresIn: 3600,
      sendVerificationEmail: async ({ user, url }) =>
        mail.enqueue({
          to: user.email,
          subject: 'Confirm your Orluma email',
          text: `Welcome to Orluma.\n\nConfirm your email address:\n${url}\n\nThis link expires in one hour. If you did not create an account, you can ignore this email.`,
        }),
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-up/email') return;
        const parsed = registerInput.safeParse(ctx.body);
        if (!parsed.success)
          throw new APIError('BAD_REQUEST', {
            message:
              'Use a valid email, a name of up to 80 characters and a password of 12–128 characters.',
          });
        Object.assign(ctx.body, { name: parsed.data.name, email: parsed.data.email });
        const first = (await db.prepare('SELECT COUNT(*) AS count FROM users').get()).count === 0;
        if (
          first &&
          bootstrapEmail &&
          String(ctx.body.email).toLowerCase() !== bootstrapEmail.toLowerCase()
        )
          throw new APIError('FORBIDDEN', {
            message:
              'This installation is waiting for its initial owner. Ask your team for an invitation.',
          });
        const invitationToken = ctx.headers?.get('x-orluma-invitation');
        if (invitationToken) {
          const invite = await db
            .prepare(
              'SELECT invitations.*, memberships.role AS inviter_role FROM invitations JOIN memberships ON memberships.workspace_id=invitations.workspace_id AND memberships.user_id=invitations.created_by WHERE token_hash=?',
            )
            .get(digest(invitationToken));
          if (
            !invite ||
            invite.used_at ||
            invite.revoked_at ||
            invite.expires_at <= Date.now() ||
            !['owner', 'admin'].includes(invite.inviter_role)
          )
            throw new APIError('FORBIDDEN', { message: 'This invitation is no longer active.' });
          if (invite.email.toLowerCase() !== String(ctx.body?.email).toLowerCase())
            throw new APIError('FORBIDDEN', {
              message: 'Use the email address on your invitation.',
            });
        } else if (!first && registrationMode !== 'open')
          throw new APIError('FORBIDDEN', { message: 'Ask your team for an invitation.' });
      }),
    },
  };
}
export function createIdentity(options) {
  return betterAuth(authOptions(options));
}
