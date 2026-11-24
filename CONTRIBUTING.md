# Contributing

Fork the repository, create a focused branch and open a pull request. Bug reports should describe the expected behavior, observed behavior, app version and reproduction steps with fictional data. Do not attach real team exports, invitation links, cookies or databases.

Use Node.js 24.x, PostgreSQL and local SMTP/Mailpit. Install with `npm ci`; `npm run setup:local` prepares private local configuration. Set a disposable `TEST_DATABASE_URL` (test role needs CREATEDB) and PostgreSQL client tools for verification, then run `npm run dev`. See the README for production and Docker setup.

Before submitting a change:

```sh
npm run format
npm test
npm run build
npx playwright install chromium
CI=1 npm run test:e2e
```

Preserve workspace isolation, role checks, integer-cent arithmetic, version conflicts and the no-self-approval rule. Database changes need a migration and a test against an existing database. New external services must be optional and clearly documented. Keep sample identities fictional.

Use semantic controls and verify keyboard operation, mobile layout and reduced motion. Stone & Fog uses porcelain/fog surfaces, organic relief forms, restrained typography and black pill actions. Decorative shapes never stand in for a missing label or encode invented forecasts.

The code is MIT licensed. By submitting a contribution, you agree that it can be distributed under the project’s MIT license. Include the license and provenance for new third-party assets. Report security issues privately as described in SECURITY.md.
