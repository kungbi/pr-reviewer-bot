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

이 봇은 **폴링 전용**입니다. 웹훅 서버가 없습니다.

### Option 1 — Polling (자동, 항상 켜짐)

봇이 실행 중이면 `POLL_INTERVAL_MINUTES`마다 자동으로 GitHub를 폴링합니다.

`src/polling/poller.js` → `src/review/polling-reviewer.js` 순서로:
1. `gh pr list --assignee @me` 로 오픈 PR 조회
2. `state/reviewed-prs.json` 으로 중복 방지 (SHA 기반)
3. 새 PR 감지 시 sessions_spawn → AI 리뷰 실행
4. Discord 알림 전송

### Option 2 — Manual Review Trigger

특정 PR을 즉시 수동으로 리뷰하려면:

```bash
cd ~/pr-reviewer-bot
node -e "
const { executeReview } = require('./src/review/review-executor');
executeReview('org이름', 'repo이름', PR번호)
  .then(r => console.log(r))
  .catch(e => console.error(e));
"
```

예시:
```bash
node -e "
const { executeReview } = require('./src/review/review-executor');
executeReview('kungbi-spiders', 'my-repo', 42)
  .then(r => console.log(r));
"
```

봇이 실행 중이 아니어도 동작합니다.

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
