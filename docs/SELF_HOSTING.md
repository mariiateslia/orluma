# Self-hosting and operations

Use Node.js 24, PostgreSQL 16+ (locally verified on 17), and SMTP or Resend. Serve frontend and API at one origin. The current live event bus is process-local; run one app replica. PostgreSQL persists data independently of app restarts.

## Configuration

| Variable                                | Purpose                                                                                                                                                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_URL`                               | Exact public origin, e.g. `https://orluma.mariateslia.site`. No subpath hosting. Used for cookies, origin checks and email callbacks.                                                                                                    |
| `DATABASE_URL`                          | PostgreSQL URL, server only. Prefer the hosting provider’s private connection URL.                                                                                                                                                       |
| `AUTH_SECRET`                           | At least 32 random characters, generated once; signs authentication and encrypts queued mail. Preserve across restarts/deploys.                                                                                                          |
| `MAIL_FROM`                             | Verified sender in production, e.g. `Orluma <no-reply@auth.orluma.mariateslia.site>`.                                                                                                                                                    |
| `RESEND_API_KEY`                        | Optional production mail API key. If set, takes precedence over SMTP.                                                                                                                                                                    |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | Alternative mail transport. Port 465 generally uses `SMTP_SECURE=true`; STARTTLS on 587 uses false. Non-local SMTP requires TLS by default; `SMTP_REQUIRE_TLS=false` is an explicit operator override. No certificate-validation bypass. |
| `SMTP_USER`, `SMTP_PASSWORD`            | SMTP credentials if required. Local Mailpit needs neither.                                                                                                                                                                               |
| `REGISTRATION_MODE`                     | `invite` by default; first account registers, later accounts require a valid email-bound invitation. `open` explicitly permits unrestricted registrations.                                                                               |
| `BOOTSTRAP_EMAIL`                       | Initial owner email. Required on HTTPS invite-only installations; no other email can register the first account. This is not a hidden installation admin role.                                                                           |
| `HOST`, `PORT`                          | Node bind address/port. Native local defaults to loopback; managed/container hosting uses `HOST=0.0.0.0`.                                                                                                                                |
| `TRUST_PROXY`                           | Set `1` only behind exactly one trusted reverse proxy that overwrites forwarding headers and is the sole ingress.                                                                                                                        |
| `NODE_ENV`                              | `production` for public deployment.                                                                                                                                                                                                      |
| `POSTGRES_PASSWORD`                     | Local Compose database credential; native runtime uses `DATABASE_URL` instead.                                                                                                                                                           |

Use provider environment secrets or a private `.env`; never put secrets in Vite variables, browser code or Git. Production and test databases must differ. Do not change the auth secret casually: rotation invalidates authentication links/cookies and makes pending encrypted mail unreadable. Drain the queue or invalidate/resend affected links when rotating.

## Local setup

`npm run setup:local` creates `.env` with random credentials and refuses to overwrite it. `docker compose up --build -d` runs app, Postgres and a local Mailpit inbox. The inbox and database ports bind to loopback. Keep the named database volume; `down -v` destroys it.

For a non-Docker install, create a PostgreSQL database/role, configure `.env`, start your SMTP server, then run `npm ci`, `npm run build`, `npm start`. Startup applies pending versioned migrations under a database advisory lock. `npm run db:migrate` applies them without starting HTTP. Back up before upgrades; there are no automatic down migrations.

Open exactly `APP_URL` when testing the build: `localhost` and `127.0.0.1` are different origins. Development on port 5173 is supported only in development mode; Vite proxies to the backend port from `.env`.

## Publish a single shared instance

1. Create the PostgreSQL database and web service in the same region. Link the intended Git branch. Confirm the hosting quote before provisioning paid services.
2. Set server secrets and `BOOTSTRAP_EMAIL`. Build with `npm ci && npm run build`, start with `npm start`. Use `/api/health` for database readiness. The Node process needs an outbound connection to PostgreSQL and the selected mail provider.
3. Connect `orluma.mariateslia.site`, configure the DNS record shown by the host, and wait for HTTPS. Set that exact `APP_URL` before sending invitations.
4. Verify the sending domain at the email provider. Disable open/click tracking for auth emails; do not overwrite unrelated MX or SPF records.
5. Register the bootstrap account, confirm email through a real inbox, sign in, create the workspace and invite a second test account. Verify password recovery before inviting a wider team.
6. Keep SSE unbuffered, with a proxy timeout above 60 seconds. Sessions/memberships are rechecked on events and 15-second heartbeats; the browser refreshes on focus/every 20 seconds. Permission changes send invalidations; subsequent reads enforce the new role.
7. Configure provider monitoring, database backup retention and a restore drill. `/api/health` does not prove that mail was delivered. Monitor `mail_outbox` status counts and provider delivery failures without logging payloads.

A fork is a separate installation. Teammates use one shared URL; forking code does not connect their databases.

## Backup and restore

Install `pg_dump` / `pg_restore` of the same or newer major version than the server. These command-line tools run on an operator machine, not in the minimal app image. Set `PG_DUMP_BIN` / `PG_RESTORE_BIN` if not on PATH. Credentials are passed through environment variables rather than process arguments.

```sh
npm run backup -- /private/backups/orluma.dump
```

This produces a private custom-format consistent database snapshot and refuses to overwrite an existing file. Transfer it to protected off-host storage. Back up `AUTH_SECRET` separately; a SQL dump alone cannot recover encrypted pending mail. Restrict external access to managed database URLs.

To restore, stop the app, create a **new empty database**, configure its `DATABASE_URL` and run:

```sh
npm run restore -- /private/backups/orluma.dump
npm start
```

Restore refuses a database containing user tables. Retain the old database until row counts and user flows have been checked. JSON workspace exports are not full backups and do not contain login records.

## Move from SQLite v0.1

1. Stop the old app and take an untouched backup of `data/orluma.sqlite` plus its WAL if still open. Keep the old installation intact.
2. Point this branch’s `DATABASE_URL` at a fresh PostgreSQL database. Configure mail and a stable `AUTH_SECRET`.
3. Run `npm run import:sqlite -- /absolute/path/to/orluma.sqlite`. The importer opens the source read-only, checks the target is empty, imports users and domain rows in one transaction, preserving IDs, relationships and exact cents. Any failure rolls back.
4. Legacy password hashes are accepted through the auth adapter. Imported accounts start unverified; users sign in, request a confirmation email and confirm ownership before accessing data. Existing browser sessions and outstanding invitations are invalidated; issue new invitations.
5. Check table counts, workspace membership and budget totals before switching the public URL. Do not run two writable installations during the cutover.

## Password recovery

The normal flow is **Sign in → Forgot password → email link → new password → sign in**. Links expire in one hour, are one-use, and resetting revokes all existing sessions. Unknown email addresses receive the same public response. Users can request another link; mail delivery is queued and retried, rather than assumed synchronous.

Emergency operator recovery is available when email is unavailable. Stop Orluma first, then run:

```sh
npm run reset-password -- person@example.com
```

The terminal prompts without echoing the new password. `--stdin` is an explicit automation option; never pass passwords as arguments. Recovery revokes sessions and pending reset tokens, but does not bypass email verification.
