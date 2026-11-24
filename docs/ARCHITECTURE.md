# Architecture

## Runtime and storage

React/Vite builds a static UI served by the same Express 5 process as `/api`. PostgreSQL stores workspace data and Better Auth’s users, credential accounts, sessions, verification records and rate limits. There is no browser-only persistence or hosted identity dependency. SMTP/Mailpit is sufficient for local use; Resend is optional.

Versioned SQL lives in `server/migrations/`. Startup applies migrations in an advisory-locked transaction. `server/database.js` provides a parameterized async adapter; transactions use a dedicated pooled client through AsyncLocalStorage. Monetary values use BIGINT cents with safe-integer validation. Serializable transactions protect financial decisions, ownership changes and multi-record writes. Conflicts return 409 so the caller can refetch rather than overwrite.

## Authentication

Better Auth owns `/api/identity/*`, mounted before the Express JSON parser. Confirmed email is required for workspace access. Authentication uses HttpOnly same-site cookies and server-side sessions; cookie caching is disabled so revocations are checked against PostgreSQL. Origin checks protect writes; Better Auth also validates callback origins. Registration is invite-only after bootstrap unless explicitly opened by the operator. A public invite-only instance requires an initial `BOOTSTRAP_EMAIL`.

Passwords are hashed with Better Auth’s scrypt implementation. The SQLite importer retains old scrypt hashes for compatibility; no plaintext passwords are copied. Password reset is expiring and one-use, revokes sessions and does not reveal whether an email exists. Role checks use current database membership rather than client claims.

## Mail

`server/mail.js` queues messages durably in PostgreSQL. Payloads, including bearer links, are encrypted with AES-256-GCM and a key derived from `AUTH_SECRET`. Workers atomically claim jobs using a lease/row locks, retry transient failures up to five attempts, and clear payloads on delivery, terminal failure or expiry. Resend uses an idempotency key per job; SMTP can deliver a duplicate after a process crash, so acceptance/reset endpoints remain one-use. Queued invitations and their activity record commit together. Email content reaches the chosen provider; this is not an end-to-end encrypted mail service.

There is one app replica for the beta. Its queue worker runs in-process with a durable database queue. Provider acceptance is not proof of inbox delivery. Delivery status monitoring and bounce handling remain launch operations.

## Financial authorization

Owners/admins manage and read full finance. Members can submit requests and see only their own requests and linked expenses; viewers have no financial reads. Workspace snapshots redact project budget amounts (`null`), omit allocations, filter requests/expenses/comments and filter finance activity before limiting history. Direct entity mutations, comments and exports use the same server policy. Project metadata update responses also redact financial fields. General tasks and documents are shared, not automatically content-classified.

Approval requires a different assigned owner/admin. Exact money/version checks happen inside the transaction; a unique expense request ID prevents duplicate payment recording. The audit feed is application history, not a tamper-proof compliance ledger. Bank import and token storage are a later implementation milestone.

## Collaboration

SSE broadcasts only invalidation type/time, never record content. Before each event/heartbeat the server checks the session and current membership. The UI reloads an authorized snapshot, and focus/20-second polling recover missed events. Versioned documents reject stale saves while retaining a local draft. There is no character-level collaborative document merge or distributed event bus yet.

## Portability and verification

`server/` contains the API, schema and adapters; `client/` contains UI/permission states. `scripts/` contains native/Compose setup, PostgreSQL backup/restore, explicit read-only SQLite import and operator recovery. The app is not tied to Render: any Node/PostgreSQL/SMTP installation can run it. SQL backups include auth data; workspace JSON exports intentionally do not.

Tests use synthetic identities and disposable PostgreSQL schemas/databases, cover email/auth/finance isolation and transaction races, and exercise two browser users through email confirmation and an invitation. Test mail capture is a separate loopback process, not a production endpoint.
