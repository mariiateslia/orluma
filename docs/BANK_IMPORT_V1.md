# Orluma US bank import: confirmed v1 scope

Scope confirmed by Maria on November 23, 2026: connect a bank, import transactions and track expenses. This is an implementation specification, not an implemented integration. Neither v0.1 nor the PostgreSQL/auth branch has a Plaid connection.

## Product outcome

A company administrator signs in to Orluma, connects an eligible US company bank account through Plaid Link, and sees imported operations. They can attach a posted outgoing operation to a project, task, receipt and spending request. The team can distinguish a manually entered payment from one matched to a bank transaction.

The project budget is a planning amount. Approval reserves part of that planning budget; it does not hold funds at a bank. Imported transactions describe activity that happened through a bank or card, not a payment initiated by Orluma.

Outgoing transfers, employee reimbursements, card issuing and subscription billing are outside this release. Do not enable Plaid Transfer, Auth account-number verification, an extra Balance product, Stripe Connect or Issuing merely to implement transaction history. Additional products must have a separate justified scope and cost decision.

## User-facing screens

| View                    | Required behavior                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bank connections        | Connect, institution/account labels and masked account identifiers, selected accounts, last successful sync, reconnect, disconnect and clear Sandbox/live labeling |
| Transactions            | Date, description/merchant, exact amount and currency, pending/posted state, import status and matched/unmatched filters; returns and corrections remain traceable |
| Expense detail          | Attach a posted operation to a project/task/request, add a private receipt, view source and match history, remove/correct a match without deleting bank evidence   |
| Existing project budget | Count a verified matching expense once; distinguish approval, manual recording and bank matching                                                                   |

No instant-sync claim: show the time of the latest provider update and clear progress/error states. A pending operation is not a confirmed expense.

## Access boundaries

- Bank connection setup, raw operations, tokens and full account metadata are restricted to workspace owners/admins in the first release. Membership changes are enforced server-side and revoke access.
- Ordinary members see only financial information explicitly shared through the supported project/request permission model, not the entire bank feed.
- Tokens never appear in the browser, exports, logs, repository or ordinary workspace snapshots. Store them encrypted with a key managed separately from the database and record the encryption key version.
- Private receipts require authorized downloads; bucket URLs are not public.
- The PostgreSQL/auth branch now redacts full finance from members and viewers. Bank-specific permissions must receive additional tests before live bank data is introduced.

## Backend and data design

Proposed common deployment: Node/Express, PostgreSQL, Better Auth, configurable email delivery, private S3-compatible storage and a durable sync worker. PostgreSQL and verified-email auth are implemented locally in feature/postgres-auth-finance. Private storage, bank integration and its sync worker remain unimplemented.

Separate these records:

- `bank_connections`: workspace, environment, provider Item identifier, encrypted access token, institution, connection/consent state, active/disconnecting/disconnected state, sync cursor and last successful update.
- `bank_accounts`: connection, provider account identifier, masked display metadata, currency and selected/hidden state.
- `bank_transactions`: connection/account, provider transaction identifier, pending predecessor identifier, date, exact amount/currency, pending/posted/removed state and import timestamps.
- `expense_matches`: bank transaction, expense/project and optional task/request, matching actor, state and audit timestamps.
- `sync_jobs`: connection, job state, retry policy, safe error code and completion information.
- Existing expenses gain an explicit source/matching state. Manual entry and verified bank evidence remain distinguishable.

Use unique provider identifiers within the relevant connection/environment. Enforce one active match per bank transaction and expense for v1. Store identifiers as case-sensitive opaque strings. Use exact decimal parsing and supported currency precision; do not convert provider money with unguarded floating-point multiplication. Preserve the source currency rather than combining different currencies into one total.

## Integration sequence

1. An authorized owner/admin starts Connect bank. The backend creates a short-lived Link token for US Transactions with the configured webhook URL; bind the attempt to that workspace and user.
2. The user completes Plaid Link. The backend exchanges the temporary public token, verifies/deduplicates the connection, encrypts the access token, and queues initial synchronization. Bank credentials are not stored by Orluma.
3. The worker uses `/transactions/sync`, retrieving all pages and applying changes plus the new cursor atomically. A retry must not double-count or skip changes.
4. Verify provider webhook authenticity. Enqueue bounded, deduplicated jobs; do not trust a client-submitted Item/workspace identifier to determine authorization.
5. Process additions, modifications and removals. A posted operation can replace a pending operation with a different identifier and changed amount; preserve any review context without counting both.
6. Show initial import, updating, delayed, reconnect-required and failed states. Use Link update mode for reconnection. Manual sync requests are rate-limited and do not automatically invoke separately billable refresh endpoints.
7. On disconnect, stop new jobs, remove the provider Item and purge access credentials after successful revocation. If provider revocation fails, retain the encrypted token only for restricted retry, clearly display the incomplete disconnect and block new imports. Historical data handling follows an explicit retention/deletion choice.

Provider credentials and encryption keys are installation configuration. Sandbox is the development default. Production requires an explicit environment setting, correct provider access and a configured public HTTPS endpoint. An installation must never silently switch environments.

## Expense matching without double-counting

Suppose a $450 request was approved. Its $450 contributes to reserved budget.

- If the bank feed imports a posted $450 outflow, it stays unmatched until a finance-authorized user chooses the correct request/project.
- Matching that operation to the approved request creates/links exactly one expense and moves $450 from reserved to spent. The provider operation and match are the evidence; mere similarity of date or merchant is insufficient for automatic confirmation in v1.
- If somebody already recorded the same payment manually, matching verifies the existing expense instead of creating another $450 charge.
- A second attempt to use the same bank operation is rejected.
- A pending operation, mismatched amount/currency, partial payment or split payment cannot silently settle the whole request. Require a clear supported correction or leave unmatched; split/partial allocation is outside v1.
- A removed or modified source operation marks affected matches for review. A refund is a separate, traceable operation; do not silently rewrite the original history.
- Correcting/unmatching bank evidence does not imply a bank reversal. Preserve manual records and provenance or explicitly reverse an import-created expense/reservation effect in an audited transaction so totals remain correct.

## Cost and distribution

For a small hosted pilot, the preliminary infrastructure allowance remains $20–40/month, excluding domain/tax, development/maintenance and actual Plaid charges. This is an estimate under low traffic, not a cap or a complete banking quote.

For v1, the model is hosting/database/worker plus email/storage/backup overages and the contracted Transactions connection/usage charges. There is no outgoing-payment processor in scope. Sandbox usage is free; Production rates must be confirmed through the access application.

Plaid Transactions commonly bills monthly per active Item; an Item is a bank login and may include several accounts. Disconnection must actually remove the Item to end the relevant provider subscription. Show selected products, billable connection counts and configurable pilot enrollment limits to the operator. Prevent duplicate connections and do not promise unlimited free live bank connections.

In a Maria-hosted service, the operator pays these bills unless a separate customer pricing model is introduced. In a self-hosted installation, the team supplies and pays for its own provider credentials and infrastructure. A fork never inherits Maria’s live access or keys.

## Build order and acceptance

1. PostgreSQL migrations, auth/recovery, finance access rules and database/file recovery checks.
2. Real Plaid Sandbox Link, exchange, worker and durable sync; labeled fake provider fixtures alone do not satisfy this step.
3. Bank connection and transaction screens with reconnect/disconnect.
4. Matching to existing project/task/request records and private receipts, with duplicate/pending/currency guards.
5. Clean installation, update, two-user isolation, webhook/retry, provider correction and restore tests.
6. Production access/rate review, shared HTTPS deployment and a deliberately limited live pilot using authorized company accounts.

Completion means a pilot administrator can independently connect an eligible live account, import an operation, match it once to a project expense, and see correct totals after restart and sync. Sandbox success and automated fixtures must be reported separately from a verified Production connection. No live bank integration is claimed until that has happened.

## Primary references

- [Plaid Link](https://plaid.com/docs/link/)
- [Transactions integration](https://plaid.com/docs/transactions/)
- [Pending, posted and modified transaction behavior](https://plaid.com/docs/transactions/transactions-data/)
- [Cursor-based sync](https://plaid.com/docs/transactions/sync-migration/)
- [Item removal](https://plaid.com/docs/api/items/#itemremove)
- [Pricing and billable events](https://plaid.com/docs/account/billing/)
- [General production and infrastructure proposal](PRODUCTION_PLAN.md)
