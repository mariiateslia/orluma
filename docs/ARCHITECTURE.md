# Architecture

The browser talks to one same-origin Express API. React + TypeScript + Vite build to `dist/`. Express serves that frontend and persists application data through Node’s native `node:sqlite` module (experimental in the supported Node 24 runtime). The only required runtime service is this Node process, with a writable local data directory.

## Data and permissions

Users and sessions are installation-wide. Memberships grant roles independently per workspace. Projects belong to a workspace; tasks, documents, requests, expenses and comments carry workspace/project identifiers checked on every API operation. The server does not trust client role checks or client totals.

Passwords use salted scrypt hashes. Session tokens are 256-bit random values; only their SHA-256 hashes are stored. Cookies are HttpOnly, SameSite=Lax, expire after seven days, and are Secure when `APP_URL` uses HTTPS. Mutations require JSON and an exact allowed Origin. Production CSP uses same-origin scripts, fonts and connections. Markdown does not render raw HTML or fetch remote images.

Invitation tokens are random, hashed at rest, single-use, email-bound and expiring. Revoking an inviter’s admin privileges invalidates their outstanding invites. Server-side role checks cover reads, mutations, exports and SSE streams. Workspace viewers see financial data but cannot edit. There is no installation-wide super-admin web UI.

## Consistency

SQLite uses foreign keys, WAL, a busy timeout and synchronous `BEGIN IMMEDIATE` transactions around multi-record mutations. Financial actions check the latest record version and balance inside the same transaction. Money uses integer cents; approved requests and active expenses contribute separately to available budget. A unique `expenses.request_id` prevents duplicate payment records for one request.

Editable entities carry a version. Documents reject stale writes with HTTP 409 and return the current version for comparison; the client retains its local draft. Activity records are written transactionally with the corresponding change. The audit trail is application history, not a tamper-proof compliance ledger.

## Updates

SSE sends only invalidation events, not private record payloads. Each event and heartbeat checks the session and current membership. Clients then request a fresh authorized workspace snapshot. Permission removal closes the affected streams. A 20-second visible-tab refresh and focus refresh recover missed events. This first version loads a full workspace snapshot and is intended for small teams; pagination and multi-instance event distribution are future work.

## Repository

- `client/`: UI, API client, routes, forms and the Stone & Fog visual system.
- `server/`: schema, validation, authentication and workspace-scoped API.
- `scripts/`: development runner, backup, recovery and isolated verification helpers.
- `tests/`: API/SQLite tests and a two-user Playwright flow.
- `public/`: original Orluma imagery and icon; bundled fonts are local npm assets.
- `docs/`: self-hosting and architecture notes.

No proprietary Huly code, external user account store, hosted database client or production Chrome API mock is used. Sample data is fictional and opt-in. Tests use temporary databases and synthetic identities.
