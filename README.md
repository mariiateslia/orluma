# Orluma

A shared place to move things forward. An open-source workspace for small teams: projects, tasks, documents and spending in context.

![Project budget with fictional sample data](docs/images/budget.png)

**PostgreSQL / verified-email beta, in development.** This branch adds the production foundation to v0.1; it has not been deployed to a public service. The application is self-hosted, without per-seat billing. Operators pay for their own hosting and email delivery.

## What works

- Persistent PostgreSQL data, versioned migrations, backups and restore tools.
- Email/password registration, email confirmation, sign-in, password changes and one-use password recovery with session revocation through Better Auth.
- Email invitations, bound to a verified address, with seven-day expiry, revocation and one-use acceptance.
- Workspaces with owner, admin, member and viewer permissions, enforced by the API.
- Projects, task lists and boards, assignments, comments, Markdown documents and version conflict recovery.
- Project budgets, category allocations, requests with a separate approver, recorded expenses and activity.
- Server-sent invalidations and refresh fallback for small-team collaboration.
- Stone & Fog visuals, bundled fonts and artwork, responsive controls and reduced-motion support.

## Start locally

Install Node.js 24 and Docker with Compose, then:

```sh
npm ci
npm run setup:local
docker compose up --build -d
```

Open **http://localhost:3000** and the local email inbox at **http://localhost:8025**. Register, open your confirmation email, follow its link, sign in and create a workspace. The optional Website launch project contains fictional data. Mailpit captures email locally; it does not deliver to real inboxes.

The setup command creates random database/authentication secrets in a private, ignored `.env`. It never overwrites existing configuration. Keep these values. Compose stores PostgreSQL in a named volume; **`docker compose down -v` deletes it**.

For native Node development, start PostgreSQL and Mailpit (e.g. `docker compose up -d postgres mailpit`), then `npm run dev`. Vite runs at http://127.0.0.1:5173 and proxies the API to `PORT` from `.env`. A production-style local build uses `npm run build && npm start` at `APP_URL`.

See [self-hosting, migration and recovery](docs/SELF_HOSTING.md), [Maria’s service setup](docs/SETUP_FOR_MARIA_RU.md), and [architecture](docs/ARCHITECTURE.md).

## Access to financial data

| Capability                                             | Owner / admin                      | Member            | Viewer |
| ------------------------------------------------------ | ---------------------------------- | ----------------- | ------ |
| Read tasks and documents                               | Yes                                | Yes               | Yes    |
| Edit work and add comments                             | Yes                                | Yes               | No     |
| Read full budgets, allocations and all spending        | Yes                                | No                | No     |
| Read spending requests and linked expenses             | All                                | Own requests only | No     |
| Submit a spending request                              | Yes                                | Yes               | No     |
| Record an approved request as paid                     | Yes                                | Own request       | No     |
| Review a request                                       | Assigned reviewer, never their own | No                | No     |
| Manage budgets, record/void expenses, export workspace | Yes                                | No                | No     |
| Invite members/viewers                                 | Yes                                | No                | No     |
| Invite admins, change roles, remove other members      | Owner only                         | No                | No     |

A workspace role applies only within that workspace. The last owner cannot leave or demote themselves. Pending approvals must be resolved before removing their assigned approver. Removing or demoting someone restricts future server responses; it cannot erase data they previously viewed. General team documents and task descriptions remain shared: do not paste confidential financial details into them.

## Money and scope

Amounts are exact integer cents. Each project has one currency; currencies are never combined into a misleading total.

```text
Available = project budget − active recorded expenses − approved commitments
```

Approval reserves a planning amount atomically. Recording a payment moves it from reserved to spent once. Actual spending can exceed a budget and is displayed as a shortfall; new approvals cannot overcommit it. Allocations organize a budget, rather than enforce category caps. The contour rings are decorative, not forecasts.

Orluma currently records payments made elsewhere. **Bank connection and transaction import are not implemented in this branch.** The agreed next financial release targets US bank import and expense tracking; see [scope](docs/BANK_IMPORT_V1.md). There are no payouts, corporate cards or subscription charges.

## Privacy and operations

Team records, accounts and sessions live in the operator’s PostgreSQL database. Better Auth runs inside Orluma; it is not a hosted identity account. Passwords are hashed; sessions use HttpOnly cookies, with Secure cookies on HTTPS. Mail uses configurable SMTP or Resend. Authentication links in the durable mail queue are encrypted and cleared on delivery/expiry. Keep `AUTH_SECRET` with your backups and out of Git.

No analytics or AI calls are made by the app. Email content goes to the configured email provider; hosting and providers can retain technical logs. Workspace JSON exports exclude authentication records; full database backups contain sensitive team/authentication data.

This beta has automated checks, but no independent security audit, SSO, MFA, private attachments, character-level live document editing, account-deletion UI or multi-instance event bus. Deployment, backup scheduling, monitoring and incident handling remain operator responsibilities.

## Verify and contribute

Use a **separate disposable PostgreSQL database** and a test role with `CREATEDB`. Never use customer data. Add PostgreSQL client tools of the same or newer major version to PATH for backup/restore tests.

```sh
# Set TEST_DATABASE_URL locally; do not commit credentials.
npm test
npm run build
npx playwright install chromium
CI=1 npm run test:e2e
npm run format:check
```

API tests use random schemas; operations tests create and remove disposable databases. Browser tests run two isolated sessions and a separate loopback-only email capture server, excluded from the production API. CI also defines a container startup/restart smoke test. Local execution of that job requires Docker.

Fork, create a branch and submit a pull request. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). No paid account is required for local development.

## License and credits

Code is [MIT](LICENSE). Approved Orluma imagery and the logo can be reused with the app under the terms in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Reference artwork is not redistributed.
