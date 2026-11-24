# Production foundation and launch plan

## Status — November 23, 2026

The `feature/postgres-auth-finance` branch implements steps 1–2 locally: PostgreSQL, Better Auth, verified registration, password recovery, email invitations and server-enforced financial access. It preserves the approved soft-oval background and compact two-form logo. This is a local implementation milestone, not a deployed production service.

There are no production Render/Resend resources configured, no DNS changes, and no live Plaid integration. No paid subscriptions were started. Maria selected `orluma.mariateslia.site` for the first shared beta.

## Implemented in this branch

- PostgreSQL migrations and pooled async access; serializable financial/ownership transactions.
- Better Auth inside Express; confirmed email, secure sessions, expiring one-use password reset and session revocation.
- Durable encrypted email queue with SMTP and Resend adapters; invitation creation queues mail atomically.
- Email-bound, expiring invitations accepted only by a verified identity.
- Owner/admin finance, member own-request finance, viewer work-only access across API reads/mutations/comments/exports and response redaction.
- Read-only SQLite import into an empty PostgreSQL target, backup/restore and emergency operator recovery.
- Local setup, Compose definition, CI definition and synthetic-data API/browser verification.

## Before the shared beta

1. Review/merge the implementation and run hosted CI, including the container smoke job. Local Docker execution depends on an available Docker engine.
2. Confirm a hosting/database quote and backup retention. Create one shared web instance and PostgreSQL in the same US region.
3. Verify the sending subdomain and configure server secrets, `APP_URL`, bootstrap email, DNS and HTTPS. See [Maria’s setup](SETUP_FOR_MARIA_RU.md).
4. Check registration, real email delivery, expiry/resend, password recovery and invitation acceptance on the deployed origin.
5. Test roles in separate real sessions, monitor delivery failures and database errors, and complete a restore drill. Keep the previous SQLite installation untouched until any migration cutover is verified.
6. Invite a small test team. Publish the supported scope and known limitations alongside the repository.

## Next financial milestone

USA, bank connection, transaction import and expense tracking. Implement Plaid Sandbox first, tenant-scoped bank connections and encrypted access-token storage, signed webhook validation, idempotent sync/retries, reconnect/disconnect, transaction matching and private receipts. Then obtain and price the appropriate Production access for the actual use case. See [BANK_IMPORT_V1.md](BANK_IMPORT_V1.md).

Payouts, reimbursements through payment rails, card issuance and charging subscriptions are separate scope decisions. An approval or “record payment” action currently records a decision or external payment; it never moves money.

## Ongoing limits

One app replica with process-local invalidations; no distributed event bus, MFA/SSO, attachment storage or independent security audit. Hosted pricing is not guaranteed by the open-source license. Self-hosters supply their own infrastructure and provider accounts.
