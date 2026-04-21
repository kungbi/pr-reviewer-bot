# ThomasShelby PR Reviewer Bot

GitHub PR 리뷰 요청을 감지하여 AI 코드 리뷰를 자동으로 수행하는 봇.

`backend-woongbi`에게 리뷰 요청된 PR을 5분마다 폴링 → AI 분석 → 인라인 코멘트 + Discord 알림.

---

## 동작 방식

```
GitHub Search API (5분마다)
       ↓
review-requested:backend-woongbi 조건으로 오픈 PR 조회
       ↓
새 PR 또는 새 커밋 감지 (SHA 기반 중복 방지)
       ↓
sessions_spawn → OpenClaw agent (AI 리뷰)
       ↓
GitHub 인라인 코멘트 (file:line 단위)
       ↓
Discord 알림 (리뷰 시작 / 완료)
```

---

## 파일 구조

```
kungbi-pr-reviewer-bot/
├── src/index.ts              # 엔트리포인트 (폴링 시작)
├── src/
│   ├── poller.js             # cron 폴링 (5분 간격)
│   ├── polling-reviewer.js   # 재시도 래퍼
│   ├── review-executor.js    # AI 리뷰 실행 + 인라인 코멘트
│   ├── diff-parser.js        # unified diff 파싱 (file:line 추출)
│   ├── github.js             # GitHub API 래퍼
│   ├── discord-notifier.js   # Discord webhook 전송
│   ├── state-manager.js      # 리뷰 완료 PR 상태 추적 (SHA 포함)
│   ├── comment-monitor.js    # PR 코멘트 모니터링
│   ├── logger.js
│   ├── config.js
│   └── errors.js
├── tools/
│   └── sessions_spawn.js     # OpenClaw agent 호출
├── state/                    # reviewed-prs.json (git 제외)
├── .env                      # 실제 환경변수 (git 제외)
├── .env.example
├── START.sh
├── KILL.sh
└── package.json
```

---

## 환경 변수

`.env.example` 복사 후 편집:

```ini
# GitHub Personal Access Token (repo, read:org 권한 필요)
GH_TOKEN=ghp_your_token_here

# Discord Incoming Webhook URL
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...

# 봇 표시 이름
BOT_NAME=ThomasShelby

# 폴링 간격 (분)
POLL_INTERVAL_MINUTES=5

# 로그 레벨: DEBUG | INFO | WARN | ERROR
LOG_LEVEL=INFO
```

---

## 실행

```bash
npm install
cp .env.example .env   # .env 편집 후
npm run build
npm start
```

---

## 의존성

- **OpenClaw**: AI 리뷰는 `openclaw agent` CLI를 통해 실행되므로, 봇이 OpenClaw가 설치된 환경에서 동작해야 함
- **GitHub Token**: `review-requested` 검색 및 PR 코멘트 작성 권한 필요
- **Discord Webhook**: 리뷰 시작/완료 알림용

---

## SHA 기반 재리뷰

PR을 이미 리뷰했더라도 새 커밋이 push되면 자동으로 재리뷰 실행. `state/reviewed-prs.json`에 커밋 SHA를 저장하여 비교.

---

## 트러블슈팅

**리뷰가 안 됨**
- `GH_TOKEN` 권한 확인 (`repo`, `read:org`)
- OpenClaw gateway 실행 중인지 확인: `docker compose ps`

**Discord 알림 없음**
- `DISCORD_WEBHOOK_URL` 값 확인

**인라인 코멘트가 안 달림**
- AI가 `**file:line**` 형식으로 이슈를 출력해야 파싱 가능
- diff에 포함된 라인에만 코멘트 가능 (GitHub 제약)
