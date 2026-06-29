# PR Reviewer Bot

GitHub에서 `GH_REVIEWER`에게 리뷰 요청된 PR을 주기적으로 폴링하고, AI 코드 리뷰를 실행한 뒤 GitHub PR 리뷰/인라인 코멘트와 Discord 알림을 남기는 봇입니다.

현재 운영 방식은 **polling mode**입니다. GitHub webhook 서버/HMAC 검증 플로우는 사용하지 않습니다.

---

## 동작 방식

```text
GitHub Search API polling
  ↓
review-requested:<GH_REVIEWER> 조건의 open PR 조회
  ↓
state/reviewed-prs.json으로 중복 방지
  - 같은 HEAD SHA면 skip
  - 새 commit이면 재리뷰
  ↓
필요 시 PR branch를 /tmp에 shallow clone
  ↓
REVIEW_AGENT에 설정된 CLI agent 실행
  - codex | claude | opencode
  ↓
agent가 GitHub review / inline comments 게시
  ↓
봇이 review 게시 여부 확인
  ↓
Discord 알림 전송
  - 리뷰 시작
  - 리뷰 완료
  - 리뷰 실패 / 영구 스킵
  ↓
review-comment reply monitor
  ↓
사람이 봇 review comment thread에 답글을 달면 감지
  ↓
사람이 단 답글 내용과 URL을 Discord에 알림
  ↓
agent가 답변 필요 여부를 판단하고, 필요 시 같은 GitHub review thread에 답글 게시
  ↓
봇이 답글을 게시한 경우 답글 내용과 URL을 Discord에 알림
```

---

## 현재 주요 구성

- Runtime: Node.js + TypeScript
- Process manager: PM2 (`pr-reviewer-bot`)
- Trigger: GitHub Search API polling
- Review agent: `REVIEW_AGENT`로 선택
  - 현재 운영값: `codex`
  - 지원값: `codex`, `claude`, `opencode`
- State file: `state/reviewed-prs.json`
- Reply monitor: `REPLY_MONITOR_ENABLED=true`일 때 봇 review comment에 달린 사람 답글을 감지해 필요한 경우 추가 답변
- Discord notification: `DISCORD_WEBHOOK_URL`

---

## 파일 구조

```text
pr-reviewer-bot/
├── src/
│   ├── index.ts                    # entrypoint, polling 시작
│   ├── poller.ts                   # GitHub review-request polling
│   ├── github.ts                   # GitHub REST API wrapper
│   ├── discord-notifier.ts         # Discord webhook 알림
│   ├── review/
│   │   ├── polling-reviewer.ts     # retry / permanent skip wrapper
│   │   ├── review-executor.ts      # PR 리뷰 orchestration
│   │   ├── repo-cloner.ts          # PR branch temp clone
│   │   └── verdict.ts              # agent output verdict 파싱
│   ├── monitoring/
│   │   └── comment-reply-monitor.ts # review comment thread 답글 감지/자동 답변
│   └── utils/
│       ├── agent-command.ts        # codex/claude/opencode command 생성
│       ├── config.ts               # 환경변수 로딩/검증
│       ├── logger.ts
│       └── state-manager.ts
├── state/reviewed-prs.json         # 리뷰 상태 저장, git 제외
├── logs/                           # PM2/runtime logs
├── dist/                           # npm run build output
├── .env                            # 실제 운영 환경변수, git 제외
├── .env.example                    # 환경변수 예시
├── ecosystem.config.js             # PM2 app config
├── package.json
└── README.md
```

---

## 환경 변수

`.env.example`을 복사해서 `.env`를 만듭니다.

```bash
cp .env.example .env
```

필수/중요 변수:

| 변수 | 필수 | 설명 |
|---|---:|---|
| `DISCORD_WEBHOOK_URL` | ✅ | 리뷰 시작/완료/실패 알림을 보낼 Discord incoming webhook URL |
| `GH_TOKEN` | 권장 | GitHub API/clone/review 게시용 token. `gh auth`만으로는 일부 clone 경로가 실패할 수 있어 운영에서는 설정 권장 |
| `GH_REVIEWER` | ✅ | 봇이 감시할 GitHub reviewer username |
| `REVIEW_AGENT` | ✅ | 사용할 리뷰 agent. `codex`, `claude`, `opencode` 중 하나 |
| `CODEX_MODEL` | 선택 | `REVIEW_AGENT=codex`일 때 사용할 Codex model. 비우면 Codex CLI 기본값 |
| `REVIEW_TIMEOUT_MIN` | 선택 | PR 하나당 agent 실행 timeout, 분 단위 |
| `REVIEW_CONCURRENCY` | 선택 | 동시에 리뷰할 PR 개수 |
| `REPLY_MONITOR_ENABLED` | 선택 | 봇이 남긴 review comment thread에 사람이 답글을 달면 감지/응답할지 여부 |
| `REPLY_MONITOR_LOOKBACK_DAYS` | 선택 | reply monitor가 스캔할 최근 reviewed PR 범위. 기본 14일 |

현재 운영에서는 다음처럼 둡니다.

```ini
REVIEW_AGENT=codex
CODEX_MODEL=gpt-5.5
```

> `WEBHOOK_SECRET`는 현재 polling mode에서 사용하지 않습니다.

---

## 리뷰 대상 범위

자동 polling 모드에서는 별도의 repository 목록을 설정하지 않습니다. 봇은 GitHub Search API로 다음 조건을 만족하는 PR을 찾습니다.

- open PR
- `GH_REVIEWER`에게 review request가 걸려 있음
- `GH_TOKEN`으로 접근 가능한 repository

즉, 실제 리뷰 대상은 `GH_REVIEWER` 설정, GitHub review request 상태, `GH_TOKEN` 권한의 교집합으로 결정됩니다.

현재 버전에는 repository allowlist/denylist 기능이 없습니다. 특정 조직이나 repository만 리뷰해야 하는 환경에서는 `GH_TOKEN` 권한을 최소화하거나, allowlist 기능을 추가한 뒤 운영하세요.

### Discord 수동 트리거

`DISCORD_BOT_TOKEN`과 `DISCORD_CHANNEL_ID`를 설정하면, 지정 채널에 올라온 GitHub PR URL을 수동 리뷰 요청으로 처리합니다.

```text
https://github.com/<owner>/<repo>/pull/<number>
```

이 경우에도 `GH_TOKEN`으로 접근 가능한 PR만 리뷰할 수 있습니다.

### Cross-repo lookup

리뷰 agent는 API 계약, 공유 타입, sibling service와의 정합성을 확인해야 할 때 같은 GitHub organization의 다른 repository 파일을 일부 조회할 수 있습니다.

기본 지침:

- 전체 repository clone 금지
- 필요한 파일만 `gh api /contents/...`로 조회
- PR base branch 기준으로 조회
- 500KB 초과 파일 조회 금지

접근 가능한 범위는 결국 `GH_TOKEN` 권한에 의해 결정됩니다.

---

## 실행 / 배포

### 개발 실행

```bash
npm install
npm test
npm run build
```

`.env`를 로드한 상태에서 실행해야 합니다.

```bash
set -a
. ./.env
set +a
node dist/src/index.js
```

### PM2 운영

```bash
npm run build
npx pm2 start ecosystem.config.js
```

재시작:

```bash
set -a
. ./.env
set +a
npx pm2 restart pr-reviewer-bot --update-env
```

상태 확인:

```bash
npx pm2 status
npx pm2 logs pr-reviewer-bot
```

현재 PM2 app 이름은 `pr-reviewer-bot`입니다.

---

## 리뷰 agent 설정

`src/utils/agent-command.ts`에서 agent별 실행 커맨드를 생성합니다.

### Codex

```ini
REVIEW_AGENT=codex
CODEX_MODEL=gpt-5.5
```

실행 형태:

```text
codex exec [--model <CODEX_MODEL>] --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check <prompt>
```

### Claude

```ini
REVIEW_AGENT=claude
REVIEW_MODEL=opus
```

### OpenCode

```ini
REVIEW_AGENT=opencode
OPENCODE_MODEL=google/gemini-2.5-flash
```

agent를 바꾼 뒤에는 반드시 PM2를 `--update-env`로 재시작합니다.

```bash
set -a; . ./.env; set +a
npx pm2 restart pr-reviewer-bot --update-env
```

---

## 중복 방지 / 재리뷰

봇은 PR의 HEAD SHA를 기준으로 리뷰 상태를 저장합니다.

- 같은 PR + 같은 HEAD SHA: 이미 리뷰한 것으로 보고 skip
- 같은 PR + 새 HEAD SHA: 새 commit이 push된 것으로 보고 재리뷰
- 리뷰 실패: retry count를 기록하고 재시도
- 최대 재시도 초과: permanent skip으로 기록

상태 파일:

```text
state/reviewed-prs.json
```

특정 PR을 다시 리뷰하게 만들려면 상태 파일에서 해당 PR entry를 제거한 뒤 PM2를 재시작합니다.

## Review comment 답글 자동 응답

`REPLY_MONITOR_ENABLED=true`이면 봇은 polling tick마다 최근 reviewed PR의 review comments를 조회합니다.

```text
GET /repos/{owner}/{repo}/pulls/{pull_number}/comments
```

GitHub review comment reply는 `in_reply_to_id`를 갖습니다. 봇은 다음 조건을 만족하는 댓글만 처리합니다.

- 사람이 단 reply임
- reply의 parent comment 작성자가 봇임
- `replyMonitorStartedAt` 이후에 작성됨
- `state/reviewed-prs.json.repliedComments`에 아직 처리 기록이 없음

처리 대상이면 먼저 Discord에 사람이 단 reply 본문과 URL을 전달합니다. 이후 agent가 답변 필요 여부를 판단합니다. 단순 감사/확인성 답글은 GitHub에 추가 답변을 달지 않지만 Discord 알림은 남습니다. 질문/반박/설명 요청이면 같은 review thread에 답변합니다.

```text
POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{parent_comment_id}/replies
```

중복 방지와 과거 댓글 폭탄 방지는 `state/reviewed-prs.json`에 저장됩니다.

Discord 알림은 두 종류입니다.

- `💬 리뷰 댓글 답글 감지`: 사람이 봇 review comment에 답글을 단 경우. 사람 답글 본문, 댓글 ID, URL 포함
- `🤖 봇 답글 게시`: 봇이 추가 답변을 게시한 경우. 봇 답글 본문과 URL 포함

### Runtime data / privacy

운영 중 생성되는 runtime 파일에는 실제 리뷰 대상 repository 이름, PR 번호, PR 제목, 실행 로그가 남을 수 있습니다.

커밋하면 안 되는 파일/디렉토리:

```text
.env
state/reviewed-prs.json
reviewed-prs.json
logs/
.omc/
dist/
```

위 경로들은 `.gitignore`에 포함되어 있습니다. 공개 배포나 백업 전에 runtime 파일이 섞이지 않았는지 확인하세요.

---

## 트러블슈팅

### Discord에 “리뷰 실패”가 반복해서 뜸

1. PM2 환경 확인

```bash
npx pm2 jlist | jq '.[] | select(.name=="pr-reviewer-bot") | .pm2_env.env.REVIEW_AGENT'
```

2. agent CLI 확인

```bash
codex --version
```

3. 로그 확인

```bash
npx pm2 logs pr-reviewer-bot --lines 200
```

4. `.env` 변경 후 재시작했는지 확인

```bash
set -a; . ./.env; set +a
npx pm2 restart pr-reviewer-bot --update-env
```

### 새 PR을 못 찾음

- `GH_REVIEWER` 값 확인
- `GH_TOKEN` 권한 확인: private repo 접근 및 PR review 게시 권한 필요
- GitHub Search API rate limit 확인

### 인라인 코멘트가 안 달림

- GitHub는 diff에 포함된 line에만 inline comment를 허용합니다.
- agent가 review를 게시했는지 봇이 `verifyReviewPosted`로 확인합니다.
- review는 올라갔지만 inline comment가 거절되는 경우, GitHub API 422 로그를 확인합니다.

---

## 품질 체크

변경 전후 최소 확인:

```bash
npm test
npm run build
```

현재 테스트 스위트는 Jest 기반입니다.
