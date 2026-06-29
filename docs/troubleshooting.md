# Troubleshooting

PR Reviewer Bot 운영 중 자주 보는 문제와 확인 절차입니다.

## Discord에 “리뷰 실패”가 반복해서 뜸

대부분 review agent CLI 실행 실패, 환경 변수 불일치, 또는 PM2 재시작 누락입니다.

1. PM2 환경 확인

```bash
npx pm2 jlist | jq '.[] | select(.name=="pr-reviewer-bot") | .pm2_env.env.REVIEW_AGENT'
```

2. agent CLI 확인

```bash
codex --version
claude --version
opencode --version
```

3. 로그 확인

```bash
npx pm2 logs pr-reviewer-bot --lines 200
```

특히 아래 형태면 process `PATH`에서 agent CLI를 못 찾는 문제입니다.

```text
spawn codex ENOENT
spawn claude ENOENT
spawn opencode ENOENT
```

4. `.env` 변경 후 재시작했는지 확인

```bash
set -a; . ./.env; set +a
npx pm2 restart pr-reviewer-bot --update-env
```

## 새 PR을 못 찾음

- `GH_REVIEWER` 값이 실제 review request 대상 GitHub username과 일치하는지 확인
- `GH_TOKEN`에 private repo 접근 및 PR review 게시 권한이 있는지 확인
- GitHub Search API rate limit 확인
- PR이 open 상태인지 확인
- 해당 PR에 실제로 `GH_REVIEWER` review request가 걸려 있는지 확인

## 인라인 코멘트가 안 달림

- GitHub는 PR diff에 포함된 line에만 inline comment를 허용합니다.
- agent가 review를 게시했는지 봇이 `verifyReviewPosted`로 확인합니다.
- review는 올라갔지만 inline comment가 거절되는 경우, GitHub API 422 로그를 확인합니다.

## Review comment 답글 알림이 Discord로 안 옴

- `REPLY_MONITOR_ENABLED=true`인지 확인
- `REPLY_MONITOR_LOOKBACK_DAYS` 범위 안에 해당 PR이 포함되는지 확인
- `state/reviewed-prs.json.replyMonitorStartedAt`보다 뒤에 작성된 reply인지 확인
- 사람이 단 reply의 parent comment 작성자가 봇 계정인지 확인
- 이미 `state/reviewed-prs.json.repliedComments`에 처리 기록이 있으면 다시 알림/응답하지 않습니다.

## 봇이 사람 reply에 답글을 안 담

사람 reply 감지 알림은 Discord로 가지만, GitHub에 추가 답글을 달지는 않을 수 있습니다.

봇은 agent 판단 결과가 `REPLY_NEEDED`일 때만 GitHub review thread에 답글을 답니다. 아래처럼 단순 확인/감사성 reply는 처리 기록만 남기고 추가 답글을 생략합니다.

```text
감사합니다
확인했습니다
넵
resolved
```

## 상태 파일 초기화 / 특정 PR 재처리

상태 파일은 git에 커밋하지 않는 runtime 데이터입니다.

```text
state/reviewed-prs.json
```

특정 PR을 다시 리뷰하게 만들려면 해당 PR entry를 제거한 뒤 PM2를 재시작합니다. reply monitor를 다시 처리하게 만들려면 `repliedComments`에서 해당 reply id를 제거해야 합니다.
