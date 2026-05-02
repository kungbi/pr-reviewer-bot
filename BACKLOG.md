# Backlog

코드 리뷰 결과 기록 (2026-04-30)

---

## 🔴 CRITICAL

### C-1. State 파일 race condition (병렬 리뷰 시 업데이트 유실)
- **파일:** `src/utils/state-manager.ts`, `src/poller.ts`, `src/review/review-executor.ts`
- **증상:** `Promise.all`로 병렬 리뷰 시 `sharedState`(executor)와 `polling-reviewer`가 각각 다른 state 인스턴스를 들고 있어 마지막 저장이 이전 저장을 덮어씀
- **수정:** 단일 state 인스턴스 공유 또는 파일 레벨 뮤텍스(proper-lockfile 등) 도입

### C-2. 모듈 import 시점에 STATE_FILE 경로 고정
- **파일:** `src/review/review-executor.ts:19-20`
- **증상:** import 시 `process.cwd()` 기준으로 경로 결정 → 테스트/PM2 환경에서 잘못된 파일 참조 가능
- **수정:** `STATE_FILE`을 `__dirname` 기준 절대 경로로 변경, load()를 첫 사용 시점으로 지연

### C-3. DISCORD_WEBHOOK_URL이 required()로 설정 시 봇 전체 시작 불가
- **파일:** `src/utils/config.ts:55`
- **증상:** Discord 미설정 시 봇이 아예 기동 안 됨. 근데 `discord-notifier.ts`는 없으면 graceful skip 처리 → 모순
- **수정:** `DISCORD_WEBHOOK_URL`을 `optional()`로 변경

---

## 🟠 HIGH

### H-1. cron 콜백에서 Promise 무시 → unhandledRejection 크래시 가능
- **파일:** `src/poller.ts:131`
- **수정:** `async () => { try { await pollAssignedPRs(); } catch (err) { logger.error(...); } }`

### H-2. Promise.all 중 하나 실패 시 전체 배치 결과 유실
- **파일:** `src/poller.ts:80-83`
- **증상:** 성공한 PR도 `markPRReviewed` 호출 안 됨
- **수정:** `Promise.allSettled` 사용

### H-3. reviewing 상태 영구 stuck (프로세스 재시작 시)
- **파일:** `src/poller.ts:75-89`, `src/utils/state-manager.ts:92-95`
- **증상:** 리뷰 도중 프로세스 죽으면 해당 PR이 `reviewing` 상태로 고착 → 이후 영구 스킵
- **수정:** `finally` 블록에서 상태 복구 or `reviewingAt` 기준 stale lock 타임아웃 처리

### H-4. markPRReviewed가 retry/failure 이력 덮어씀
- **파일:** `src/utils/state-manager.ts:114-125`
- **수정:** 기존 entry spread 후 필요한 필드만 갱신

### H-5. Discord 채널 입력 owner/repo 검증 없음 (injection 가능)
- **파일:** `src/discord-bot.ts:33-45`
- **수정:** `/^[a-zA-Z0-9._-]+$/` 정규식으로 검증 후 통과 시에만 executeReview 호출

### H-6. sessions_spawn timeout 시 promise hang
- **파일:** `src/utils/sessions_spawn.ts`
- **증상:** SIGTERM 후에도 resolve/reject 미호출 → 영원히 대기
- **수정:** 타이머로 명시적 reject 처리

### H-7. git clone URL에 토큰 포함 → stderr에 노출 가능
- **파일:** `src/review/repo-cloner.ts:122`
- **수정:** stderr에서 `x-access-token:[^@]+@` 패턴 sanitize

### H-8. inFlightReviews Set과 persistent state 이중 관리
- **파일:** `src/review/review-executor.ts:22`
- **수정:** 하나의 메커니즘으로 통일 (persistent state 권장)

### H-9. Discord bot 메시지 reply 실패 시 unhandled error
- **파일:** `src/discord-bot.ts:42`
- **수정:** for-loop 전체를 try/catch로 감싸기

---

## 🟡 MEDIUM

### M-1. console.log vs pino 혼재
- **파일:** `src/discord-notifier.ts`, `src/utils/sessions_spawn.ts`, `src/utils/config.ts`
- **수정:** 모두 pino logger로 교체

### M-2. lazy require() 3곳 → 타입 안전성 미적용
- **파일:** `src/review/review-executor.ts:93, 152, 184`
- **수정:** static import로 변경

### M-3. Discord embed description 길이 제한 없음 (4096자 초과 시 400 에러)
- **파일:** `src/discord-notifier.ts`
- **수정:** title, description truncate 처리

### M-4. isPRCompleted에 blocked/needs_work/approved 상태 누락
- **파일:** `src/utils/state-manager.ts:82-87`
- **증상:** verdict가 `blocked`/`needs_work`인 PR이 다음 폴링에서 재리뷰될 수 있음
- **수정:** allowlist에 추가 or storage 시 `'reviewed'`로 정규화

### M-5. dotenv 로딩이 index.ts import 순서에 의존
- **파일:** `src/index.ts:1-3`
- **수정:** `config.ts` 상단에서 직접 dotenv 로드

### M-6. repliedComments / getPendingReplies 미사용 dead code
- **파일:** `src/utils/state-manager.ts:127-147`
- **수정:** 사용 계획 없으면 제거

### M-7. prNumber, retryCount 배열 무한 증가
- **파일:** `src/utils/state-manager.ts:176-180`
- **수정:** `failures.slice(-MAX_RETRIES)` 로 캡

### M-8. extractVerdict 파싱 실패 시 silent fallback
- **파일:** `src/review/review-executor.ts:24-32`
- **수정:** 미매칭 시 warn 로그 추가

### M-9. getRepoInfo regex 느슨함
- **파일:** `src/poller.ts:32-38`
- **수정:** `/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/|$)/` 로 강화

### M-10. NotificationData 인터페이스 owner vs repoOwner 혼재
- **파일:** `src/types/discord.types.ts`
- **수정:** 이벤트별 인터페이스 분리

### M-11. Discord embed issueList slice 매직 넘버
- **파일:** `src/discord-notifier.ts:154`
- **수정:** `MAX_ISSUES_DISPLAYED = 5` 상수화

---

## ⚪ LOW

| ID | 내용 | 파일 |
|----|------|------|
| L-1 | `parseInt` radix 누락 | `state-manager.ts:37` |
| L-2 | `POLL_INTERVAL_MIN` 주석/예시 불일치 (seconds vs minutes) | `config.ts:86`, `.env.example` |
| L-3 | `tsconfig.json` rootDir이 `.` → emit 경로 fragile | `tsconfig.json:8` |
| L-4 | 봇 footer emoji 🕷️ 하드코딩 | `discord-notifier.ts:71` |
| L-5 | `'No attempts made'` placeholder 메시지 노출 가능 | `errors.ts:57` |

---

## 우선순위 작업 순서

1. **C-3** — DISCORD_WEBHOOK_URL optional화 (1줄 수정, 즉시 가능)
2. **H-1, H-2** — cron async 처리 + Promise.allSettled (10분 수정)
3. **H-3** — reviewing stuck lock 복구 (finally 블록 추가)
4. **H-5** — Discord 입력 검증
5. **C-1** — State race condition (가장 복잡, 단일 인스턴스 리팩터링)
6. **C-2** — STATE_FILE 절대 경로 + lazy load
