# USAGE.md — Kungbi PR Reviewer Bot

Quick-start guide for operating the bot in production or development.

---

## Starting the Bot

### Standard Start

```bash
cd /home/node/.openclaw/workspace/kungbi-pr-reviewer-bot
./START.sh
```

The bot will:
- Load environment variables from `.env`
- Start an Express server on `PORT=3000`
- Begin polling GitHub API at the configured `POLL_INTERVAL`
- Log to `logs/bot.log`

### Verify Running

```bash
curl http://localhost:3000/health
# → {"status":"ok","uptime":12345}
```

### Stopping the Bot

```bash
./KILL.sh
```

---

## How to Start Polling

Polling starts automatically when the bot launches (via `src/poller.js`).

To change the polling interval, edit `.env`:

```ini
POLL_INTERVAL=5   # seconds between polls (default: 5)
```

Restart after editing:

```bash
./KILL.sh && ./START.sh
```

---

## How to Trigger Reviews

### Option 1 — Webhook (Recommended for Production)

GitHub sends events automatically when:
- A PR is opened
- A PR reviewer is requested
- A PR is assigned

Set up in GitHub: **Repository → Settings → Webhooks → Add webhook**

- Payload URL: `https://your-domain.com/webhook`
- Content type: `application/json`
- Secret: must match `WEBHOOK_SECRET` in `.env`
- Events: select **Pull requests**

### Option 2 — Polling (Always On)

The bot polls every `POLL_INTERVAL` seconds regardless of webhooks.

Uses `src/poller.js` + `src/polling-reviewer.js` to:
1. Fetch open PRs from configured GitHub repos
2. Check if already reviewed (via `state/reviewed-prs.json`)
3. Spawn an OpenClaw subagent for each new PR
4. Post results to Discord

### Option 3 — Manual Review Trigger

Send a test event directly:

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -H "X-Hub-Signature-256: sha256=<your-hmac>" \
  -d '{
    "action": "review_requested",
    "pull_request": {
      "number": 42,
      "title": "feat: new feature",
      "html_url": "https://github.com/kungbi-spiders/repo/pull/42",
      "user": {"login": "developer"}
    },
    "requested_reviewer": {"login": "kungbi-spider"}
  }'
```

For local testing without HMAC validation, use the test script instead.

---

## How to Monitor via Discord

### What Gets Sent to Discord

| Event | Message |
|-------|---------|
| PR review requested | Full PR details with diff link, reviewer assignment |
| Review completed | Quality score (0-100), feedback summary, suggestions |
| Review failed | Error message + PR info |
| Daily summary | Stats: reviews today, avg quality, top learnings |

### Discord Message Format

```
🕷️ PR Review — kungbi-spider

Repository: kungbi-spiders/kungbi-pr-reviewer
PR: #42 | feat: new feature
Quality: 78/100
Feedback: Good structure. Add edge case tests.
Suggestions:
  - Consider adding input validation
  - Ensure test coverage for the fix

Reviewer: kungbi-spider | Reviewed: 2026-04-14T14:42:00Z
```

### Daily Summary (Cron)

The `daily-summary.sh` script generates a daily report:

```bash
./daily-summary.sh
```

Add to crontab for automatic daily delivery:

```cron
0 9 * * * cd /home/node/.openclaw/workspace/kungbi-pr-reviewer-bot && ./daily-summary.sh
```

---

## How to View Learnings

### Via Progress File

```bash
cat data/progress.txt
```

Output format:
```
=== Iteration 1 (2026-04-14T14:37:43.813Z) ===
First test learning: Check for null safety in PR diff parsing.

=== Iteration 2 (2026-04-14T14:37:43.818Z) ===
PR: test/repo#123
Quality: 8/10
Feedback: Good coverage
Suggestions: Add more edge case tests
```

### Via Iteration Counter

```bash
cat data/iteration_counter.json
# → {"count": 30}
```

### Via Test Output

```bash
cat test/output/learnings-output.txt
```

---

## Troubleshooting

### Bot not sending Discord notifications

1. Check `DISCORD_WEBHOOK_URL` in `.env` is valid
2. Test webhook directly: paste the URL in Discord channel settings → Test webhook
3. Check logs: `tail -f logs/bot.log`

### Bot not picking up new PRs

1. Verify `GH_TOKEN` is set and has `repo` scope
2. Check `state/reviewed-prs.json` — PRs marked as reviewed are skipped
3. Increase `LOG_LEVEL=DEBUG` in `.env` and restart

### Webhook rejected (HMAC error)

1. Ensure `WEBHOOK_SECRET` in `.env` matches the GitHub webhook secret
2. For local testing with ngrok: `ngrok http 3000`
3. Update GitHub webhook Payload URL to the ngrok URL

### Review subagent not spawning

1. Check `tools/sessions_spawn.js` exists
2. Check OpenClaw gateway is running: `openclaw gateway status`
3. Verify `GH_TOKEN` has permissions for the repo

### Retries happening

- **Normal behavior** — up to 3 retries per PR if review fails
- After 3 failures, PR is permanently skipped (logged in `state/reviewed-prs.json`)
- To reset: delete `state/reviewed-prs.json` and restart

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GH_TOKEN` | Yes | — | GitHub PAT or `gh auth` token |
| `WEBHOOK_SECRET` | Yes | — | GitHub webhook HMAC secret |
| `DISCORD_WEBHOOK_URL` | Yes | — | Discord incoming webhook URL |
| `BOT_NAME` | No | `kungbi-spider` | Display name in Discord |
| `PORT` | No | `3000` | HTTP server port |
| `LOG_LEVEL` | No | `INFO` | DEBUG, INFO, WARN, ERROR |
| `POLL_INTERVAL` | No | `5` | Seconds between GitHub API polls |

---

## File Locations

| File | Purpose |
|------|---------|
| `logs/bot.log` | Runtime logs |
| `state/reviewed-prs.json` | PR review state + retry counts |
| `data/progress.txt` | Learnings log |
| `data/iteration_counter.json` | Total iterations completed |
| `test/output/test-results.json` | Last test run results |
