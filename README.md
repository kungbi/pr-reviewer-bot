# 🕷️ Kungbi PR Reviewer Bot

GitHub PR 이벤트를 감지하여 Discord로 리뷰 알림을 보내는 봇.

- **Webhook mode** — GitHub이 이벤트를 push → 즉시 알림
- **Polling mode** — 주기적으로 GitHub API를 호출해 PR 상태 확인

---

## 📋 Prerequisites

| 항목 | 최소 버전 | 설명 |
|------|-----------|------|
| Node.js | 18+ | `node --version` |
| npm | 9+ | `npm --version` |
| GitHub CLI | 2.x | `gh --version` (optional, GH_TOKEN 대체 가능) |
| ngrok | any | 로컬 테스트 시 필요 |

```bash
# Node.js 설치 (nvm 사용 권장)
nvm install 18 && nvm use 18

# GitHub CLI 설치
brew install gh          # macOS
sudo apt install gh      # Ubuntu/Debian
```

---

## 🚀 Installation

```bash
# 1. 저장소 클론
git clone https://github.com/kungbi-spiders/kungbi-pr-reviewer-bot.git
cd kungbi-pr-reviewer-bot

# 2. 의존성 설치
npm install

# 3. 환경변수 설정
cp .env.example .env
# .env 파일을 편집하여 실제 값 입력
```

---

## ⚙️ Environment Setup

`.env` 파일 설정:

```ini
# GitHub Personal Access Token (gh auth login 으로 대체 가능)
# 필요 권한: repo, read:org
GH_TOKEN=ghp_your_token_here

# GitHub Webhook 서명 검증용 HMAC 시크릿
WEBHOOK_SECRET=your_github_webhook_secret_here

# Discord Incoming Webhook URL
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/your-webhook-url-here

# 봇 이름 (Discord 메시지에 표시)
BOT_NAME=kungbi-spider

# HTTP 서버 포트
PORT=3000

# 로그 레벨: DEBUG | INFO | WARN | ERROR
LOG_LEVEL=INFO

# GitHub API 폴링 주기 (초)
POLL_INTERVAL=5
```

### GitHub Token 발급

1. GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
2. 권한 선택: `repo` (Full control), `read:org`
3. 생성 후 `.env`의 `GH_TOKEN`에 입력

### Discord Webhook 생성

1. Discord 채널 → 설정 → 연동 → 웹후크 → 새 웹후크
2. URL 복사 후 `.env`의 `DISCORD_WEBHOOK_URL`에 입력

### GitHub Webhook 설정

1. GitHub 저장소 → Settings → Webhooks → Add webhook
2. Payload URL: `https://your-domain.com/webhook`
3. Content type: `application/json`
4. Secret: `.env`의 `WEBHOOK_SECRET`와 동일한 값
5. Events: **Pull requests** 선택

---

## ▶️ How to Run

```bash
# 기본 실행 (START.sh — .env 자동 로드)
./START.sh

# 백그라운드 실행 (로그 파일 저장)
./START.sh >> logs/bot.log 2>&1 &

# 직접 실행 (환경변수 미리 export 필요)
node index.js
```

### 프로세스 종료

```bash
./KILL.sh
```

---

## 🧪 Local Testing with ngrok

로컬 개발 시 GitHub이 로컬 서버로 webhook을 전달하려면 ngrok이 필요합니다.

```bash
# 1. 봇 서버 시작
./START.sh

# 2. 새 터미널에서 ngrok 터널 생성
ngrok http 3000

# 출력 예시:
# Forwarding  https://abc123.ngrok.io -> http://localhost:3000

# 3. ngrok URL을 GitHub webhook에 등록
#    Payload URL: https://abc123.ngrok.io/webhook

# 4. PR을 생성하거나 리뷰어를 지정하면 Discord 알림 확인
```

**헬스체크:**
```bash
curl http://localhost:3000/health
# → {"status":"ok","uptime":123}
```

**수동 webhook 테스트:**
```bash
# PR assigned 이벤트 시뮬레이션
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -d '{
    "action": "review_requested",
    "pull_request": {
      "number": 42,
      "title": "feat: test PR",
      "html_url": "https://github.com/org/repo/pull/42",
      "user": {"login": "developer"}
    },
    "requested_reviewer": {"login": "kungbi-spider"}
  }'
```

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────┐
│                   GitHub Events                      │
│         (PR assigned / review_requested)             │
└────────────────────┬────────────────────────────────┘
                     │
           ┌─────────┴──────────┐
           │  Webhook (push)    │  ← GitHub sends HTTP POST
           │  Poller (pull)     │  ← Bot polls every N seconds
           └─────────┬──────────┘
                     │
          ┌──────────▼──────────┐
          │     index.js        │  Express HTTP server
          │   (entry point)     │  PORT=3000
          └──────────┬──────────┘
                     │
        ┌────────────┼────────────┐
        │            │            │
┌───────▼──────┐ ┌───▼────┐ ┌────▼──────────┐
│webhook-      │ │poller  │ │state-manager  │
│handler.js    │ │.js     │ │.js            │
│(HMAC verify) │ │(cron)  │ │(seen PRs set) │
└───────┬──────┘ └───┬────┘ └───────────────┘
        │             │
        └──────┬──────┘
               │
     ┌─────────▼──────────┐
     │   github.js        │  GitHub API wrapper (gh CLI)
     └─────────┬──────────┘
               │
     ┌─────────▼──────────┐
     │ discord-notifier.js│  Discord Incoming Webhook
     └─────────┬──────────┘
               │
     ┌─────────▼──────────┐
     │     Discord        │  #pr-review 채널
     └────────────────────┘

Logs → logs/ directory
State → state/ directory (JSON files)
```

---

## 📁 Project Structure

```
kungbi-pr-reviewer-bot/
├── index.js                 # 엔트리포인트 (Express 서버)
├── src/
│   ├── config.js            # 환경변수 로드 & 검증
│   ├── webhook-handler.js   # GitHub webhook 수신 & HMAC 검증
│   ├── poller.js            # GitHub API 폴링 (cron)
│   ├── github.js            # GitHub API 래퍼
│   ├── discord-notifier.js  # Discord webhook 전송
│   ├── state-manager.js     # 처리된 PR 상태 추적
│   ├── logger.js            # 로거
│   ├── errors.js            # 커스텀 에러 클래스
│   ├── comment-monitor.js   # PR 코멘트 모니터링
│   └── sessions-wrapper.js  # OpenClaw 세션 래퍼
├── logs/                    # 로그 파일
├── state/                   # PR 상태 JSON 파일
├── .env                     # 실제 환경변수 (git 제외)
├── .env.example             # 환경변수 템플릿
├── START.sh                 # 실행 스크립트
├── KILL.sh                  # 프로세스 종료 스크립트
└── package.json
```

---

## 🔍 Endpoints

| Method | Path | 설명 |
|--------|------|------|
| POST | `/webhook` | GitHub webhook 수신 |
| GET | `/health` | 헬스체크 |

---

## 🛠️ Troubleshooting

**Bot not sending Discord notifications:**
1. Verify `DISCORD_WEBHOOK_URL` is set — test directly in Discord channel settings
2. Check latest logs: `tail logs/bot.log`
3. Set `LOG_LEVEL=DEBUG` in `.env` and restart

**Webhook signature validation failing:**
1. Confirm `WEBHOOK_SECRET` in `.env` matches the GitHub webhook secret
2. Verify Content-Type is `application/json`

**GitHub API authentication errors:**
1. Run `gh auth status` to verify
2. Or re-issue `GH_TOKEN` with `repo` scope

**Review subagent not spawning:**
1. Check `tools/sessions_spawn.js` exists
2. Verify OpenClaw gateway is running: `openclaw gateway status`

---

## 📊 Project Status

**All 10 stories COMPLETED** — See [PROJECT_SUMMARY.md](PROJECT_SUMMARY.md) for full details.

**10-Cycle Test Results:**
- 30 total reviews across 3 repos (kungbi-pr-reviewer, backend-api, frontend)
- 28 direct successes + 2 recovered via retry (cycles 4 & 6)
- 0 permanently skipped
- **93.3% direct success rate, 100% ultimate recovery**
- Average quality score: 76.5/100
- Test duration: ~3.6 seconds

See [USAGE.md](USAGE.md) for operational guide (start/stop, monitoring, learnings).
