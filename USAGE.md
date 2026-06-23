# PR Reviewer Bot Usage

운영/개발 환경에서 PR Reviewer Bot을 실행하고 점검하는 간단한 가이드입니다.

현재 봇은 **GitHub polling mode**로 동작합니다. GitHub webhook 서버나 별도 agent gateway는 사용하지 않습니다.

---

## 시작하기

```bash
cd /Users/woongbishin/pr-reviewer-bot
npm install
cp .env.example .env
# .env 값 채우기
npm test
npm run build
```

운영 실행은 PM2를 사용합니다.

```bash
set -a
. ./.env
set +a
npx pm2 start ecosystem.config.js
```

재시작:

```bash
set -a
. ./.env
set +a
npx pm2 restart pr-reviewer-bot --update-env
```

상태/로그 확인:

```bash
npx pm2 status
npx pm2 logs pr-reviewer-bot --lines 200
```

---

## 동작 방식

1. `GH_REVIEWER`에게 리뷰 요청된 open PR을 GitHub Search API로 조회합니다.
2. `state/reviewed-prs.json`에서 이미 처리한 PR/HEAD SHA인지 확인합니다.
3. 새 PR 또는 새 commit이면 리뷰를 시작합니다.
4. `PR_CLONE_ENABLED=true`이면 PR branch를 임시 디렉터리에 clone합니다.
5. `REVIEW_AGENT`에 지정된 CLI agent를 실행합니다: `codex`, `claude`, `opencode`.
6. agent가 GitHub review/inline comment를 게시합니다.
7. 봇이 review 게시 여부를 확인하고 Discord에 시작/완료/실패 알림을 보냅니다.

---

## 환경 변수

| 변수 | 필수 | 기본값 | 설명 |
|---|---:|---|---|
| `DISCORD_WEBHOOK_URL` | ✅ | — | Discord 알림용 incoming webhook URL |
| `GH_TOKEN` | 권장 | — | GitHub API, clone, review 게시용 token |
| `GH_REVIEWER` | ✅ | `reviewer-github-username` | 감시할 GitHub reviewer username |
| `BOT_NAME` | 선택 | `pr-reviewer-bot` | Discord 표시 이름 |
| `BOT_AVATAR_URL` | 선택 | GitHub 기본 이미지 | Discord avatar URL |
| `POLL_INTERVAL_MIN` | 선택 | `5` | polling 간격, 분 단위 |
| `LOG_LEVEL` | 선택 | `INFO` | `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `PR_CLONE_ENABLED` | 선택 | `true` | PR branch clone 기반 리뷰 사용 여부 |
| `PR_CLONE_DEPTH` | 선택 | `200` | shallow clone depth |
| `PR_CLONE_TIMEOUT_MS` | 선택 | `90000` | clone timeout |
| `REVIEW_AGENT` | ✅ | `codex` | 사용할 agent: `codex`, `claude`, `opencode` |
| `CODEX_MODEL` | 선택 | agent 기본값 | Codex model 이름 |
| `REVIEW_MODEL` | 선택 | `opus` | Claude model alias |
| `OPENCODE_MODEL` | 선택 | agent 기본값 | OpenCode provider/model |
| `REVIEW_TIMEOUT_MIN` | 선택 | `50` | PR 하나당 agent timeout |
| `REVIEW_CONCURRENCY` | 선택 | `3` | 동시 리뷰 개수 |
| `STATE_RETENTION_DAYS` | 선택 | `30` | 완료 상태 보관 기간 |

`WEBHOOK_SECRET`는 현재 polling mode에서 사용하지 않습니다.

---

## agent 변경

Codex 사용:

```ini
REVIEW_AGENT=codex
CODEX_MODEL=gpt-5.5
```

변경 후 PM2 환경을 갱신해야 합니다.

```bash
set -a; . ./.env; set +a
npx pm2 restart pr-reviewer-bot --update-env
```

PM2에 반영됐는지 확인:

```bash
npx pm2 jlist > /tmp/pr-reviewer-pm2.json
python3 - <<'PY'
import json
apps=json.load(open('/tmp/pr-reviewer-pm2.json'))
app=next(a for a in apps if a.get('name')=='pr-reviewer-bot')
print(app['pm2_env']['status'])
print(app['pm2_env'].get('env',{}).get('REVIEW_AGENT'))
print(app['pm2_env'].get('env',{}).get('CODEX_MODEL'))
PY
```

---

## 특정 PR 재리뷰

봇은 `state/reviewed-prs.json`에 PR별 상태와 HEAD SHA를 저장합니다.

같은 PR을 다시 리뷰하게 하려면 해당 PR entry를 삭제하고 재시작합니다.

```bash
npx pm2 restart pr-reviewer-bot --update-env
```

---

## 트러블슈팅

### Discord에 리뷰 실패가 반복됨

```bash
npx pm2 logs pr-reviewer-bot --lines 200
npx pm2 status
codex --version
```

확인할 것:

- `.env`의 `REVIEW_AGENT` 값
- PM2가 `--update-env`로 재시작됐는지
- 선택한 agent CLI가 설치/인증되어 있는지
- `GH_TOKEN` 권한이 충분한지

### 새 PR을 못 찾음

- `GH_REVIEWER`가 실제 리뷰 요청 대상 username인지 확인
- PR이 open 상태인지 확인
- GitHub token이 private repo에 접근 가능한지 확인
- GitHub API rate limit 확인

### 리뷰는 완료됐는데 인라인 코멘트가 없음

- GitHub inline comment는 diff에 포함된 라인에만 달 수 있습니다.
- agent가 top-level review만 남겼을 수 있습니다.
- PM2 로그에서 GitHub API 422 응답 여부를 확인합니다.

---

## 기본 검증

변경 후 최소 검증:

```bash
set -a; . ./.env; set +a
npm test
npm run build
```
