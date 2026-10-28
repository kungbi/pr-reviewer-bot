# Runtime state and relocated releases

Mutable state is independent of the installed JavaScript release. The default is
`<process working directory>/state`, preserving the existing service deployment's
state files. A copied `dist/` must not create its own publication history.

Set `PR_REVIEWER_RUNTIME_ROOT` to an **absolute runtime directory** when launching
from another working directory. Its `state/` subdirectory contains:

- `reviewed-prs.json`: PR/reply history and durable publication reservations;
- `review-memory.json`: review-memory archive;
- `review-report-outbox/`: recoverable report/publication snapshots;
- `review-reports/`: private generated reports;
- `repository-cache/`: default repository cache (the existing explicit
  `REPOSITORY_CACHE_DIRECTORY` override still takes precedence).

For a deployment already using `/Users/woongbishin/pr-reviewer-bot` as its working
directory, keep that working directory, or explicitly select that same runtime
root. This change does not migrate, merge, or search for alternative state files.
Do not copy an empty state file over existing history or initialize a new root as
a workaround for a publication failure. Confirm the operator-selected directory
before changing a live service; no restart is part of local verification.

On explicit startup load, a genuinely absent state file is initialized using the
publication lock and the atomic write/file-fsync/directory-fsync protocol. Existing
valid state is read without rewriting it. Malformed/unreadable state and lock or
sync failures abort load rather than resetting history. Missing canonical state
alongside an existing nonempty report outbox also aborts: reconcile the missing
history instead of guessing that publication was unattempted. Strict publication
transitions never initialize a missing file.

## Local verification

Use test-only configuration; do not source production credentials:

```sh
DISCORD_WEBHOOK_URL=https://example.invalid/test npm test -- --runInBand
npm run build
node scripts/smoke-relocated-runtime.cjs
```

Set `TMPDIR` to an isolated scratch directory when required by the environment.
The smoke copies the emitted CommonJS build to a temporary release, runs the
compiled state-path and report-integration regressions with Jest transforms
turned off from a separate working directory, and checks that no state appeared
inside the release. Transport is mocked; no GitHub or Discord writes occur. The
regressions include retained history, an explicit root, durable first-run
initialization, corrupt/missing/locked state, a real publication state machine
with one mocked HTTP POST, restart/report recovery, and no duplicate POST.
