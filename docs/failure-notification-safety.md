# Revision-scoped retry and terminal-notification safety

## Contract

- Polling and Discord/manual requests use the same retry wrapper. The wrapper
  checks durable state under the established exclusive state-file lock **before**
  acquiring the mutable `reviewing` status.
- `reviewRetryBudgets[owner/repo#number:fullHeadSha]` is independent of PR status,
  successful-review metadata, and retention. Three semantic failures exhaust that
  exact revision. A known, different full revision gets a separate budget; a
  reverted revision retains its previous budget. Neither missing reviewed SHA nor
  missing/invalid failed/current SHA proves new commits.
- Legacy failures migrate on state load. Exhausted unmarked records are marked
  `suppressed_legacy`, with no new GitHub or terminal Discord notification. A
  legacy failure without a trustworthy failed SHA blocks automatic retries until
  an operator investigates; do not guess the failed revision from a successful
  review SHA.
- A terminal notification must durably reserve `failureNotification=attempted`
  before any POST. Success becomes `completed`; rejection, response loss, or a
  terminal notification failure becomes `delivery_unknown`. **None may replay.**
  A crash before the first POST can therefore omit a notification: this is an
  intentional at-most-once/fail-closed policy, not exactly-once delivery.
- Failure-comment and terminal Discord transports each attempt POST once. Ordinary
  Discord notifications keep their prior retry behavior. Recognized provider-auth
  errors do not create a GitHub failure comment; the terminal alert is operator-only.
  This classifier does not inspect credentials or establish current authentication.
- Generic/stale state saves preserve durable retry and notification tombstones.
  Retention does not erase them or un-migrated legacy failures. Notification
  completion never resets a retry budget.
- The executor checks the wrapper's pinned revision before ordinary analysis.
  Success cleanup and transient-failure lock release compare revision ownership.
  Normal COMMENT publication and report-outbox recovery remain separate from
  failure notification handling; recovery never creates a fresh failure fallback.

## Local verification (no remote writes)

Use a scratch TMPDIR, a dummy webhook URL, and `NODE_ENV=test` (Jest sets it).
Never load production `.env`, state, or agent credentials for these checks.

```sh
DISCORD_WEBHOOK_URL=https://example.invalid/test npm test -- --runInBand
npm run build
NODE_ENV=test DISCORD_WEBHOOK_URL=https://example.invalid/test \
  node test/smoke-failure-spam.cjs
git diff --check
```

The separate compiled-artifact smoke uses actual built poller, retry wrapper,
state persistence, exclusive locks, and GitHub comment transport. Only analysis,
external transport, and operator notification delivery are replaced. It exercises
response-loss no-replay, restart, changed/reverted/unknown HEAD, legacy count 25,
auth-error suppression, and two independent child processes racing to reserve
one terminal notification. It starts no service and performs no network writes.

Do not reset/delete retry ledgers to recover authentication or resend alerts.
Any operator intervention requires an exact revision and explicit authorization;
ambiguous attempted notifications require manual reconciliation, not replay.
Deployment/restart is a separate authorized operation.
