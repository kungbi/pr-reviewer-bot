# 팀 제안: 개인 계정 의존을 없앤, 팀 맥락형 PR 리뷰봇 운영

> **목적:** 사람 리뷰를 대체하거나 무조건 지적을 늘리는 봇이 아니라, 팀이 합의한 기준과 레포 맥락을 이해하고 실제로 도움이 되는 리뷰를 남기는 하나의 PR Reviewer Bot을 운영하자.

## 한 줄 제안

현재 개인 GitHub 계정과 로컬 환경에 묶여 있는 리뷰봇을 **조직 소유 GitHub App(권장) + 전용 운영 인스턴스 + 전용 Hermes reviewbot profile**로 분리하자.

기존 Node/PM2의 폴링·상태·재시도·게시 안전장치는 유지하고, 리뷰 판단과 컨텍스트만 팀이 관리하는 방식으로 고도화한다.

---

## 1. 우리가 만들고 싶은 봇

### 아닌 것

- 모든 PR에 코멘트를 많이 다는 봇
- 스타일 취향이나 "이렇게도 할 수 있다"를 중요 이슈처럼 말하는 봇
- 사람의 최종 승인/책임을 대체하는 봇
- 개인의 대화나 기억을 무분별하게 학습하는 봇

### 원하는 것

- 실제 버그·보안·데이터 정합성·운영 위험을 먼저 잡는 봇
- 팀의 코드 컨벤션, 과거 합의, 서비스 경계를 알고 이미 “문제가 아니다”라고 정리된 지적을 반복하지 않는 봇
- 불확실한 개선 제안은 **Minor / 질문 톤**으로, 이점·리스크·레포 근거·범위를 같이 설명하는 봇
- 팀원이 댓글로 반박하거나 설명하면 최신 코드를 다시 확인하고, 틀렸다면 인정하고 다음 리뷰의 기준도 개선하는 봇
- 모든 자동 댓글이 봇/AI 작성임을 명확히 표시하고, GitHub 쓰기 권한은 통제된 한 경계에만 두는 봇

핵심은 **리뷰 양이 아니라 신뢰도와 팀 적합성**이다.

---

## 2. 지금까지 추가·강화된 기능

아래는 모든 내부 리팩터링이 아니라, 팀이 리뷰 품질과 운영 관점에서 알아야 할 변화만 묶은 것이다.

### 먼저: “리뷰 하네스”는 무엇인가

여기서 **리뷰 하네스**는 별도 AI 모델 이름이 아니다. AI가 PR을 읽은 결과를 바로 GitHub에 쓰게 두지 않고, **후보 생성 → 보조 리뷰 → 독립 검증 → 코드 기반 게시 검사 → publisher**로 통과시켜야만 댓글이 나가게 하는 실행·검증 장치다.

```text
AI의 판단만으로 GitHub 댓글 작성  ✗

PR 근거 수집
  → 1차 후보 리뷰
  → Ponytail 보조 리뷰
  → 독립 verifier
  → 코드 gate
  → publisher만 GitHub 쓰기  ✓
```

Ponytail도 단순 프롬프트 옵션이 아니라, 1차 리뷰와 별개로 실행하는 **보조 리뷰 pass**다. 아래 목록에서 이를 포함해 팀이 이해할 기능 단위로 풀어 쓴다.

### 팀 설명용: 실제로 추가·강화한 기능 20가지

| # | 기능 | 실제 동작 | 팀에 주는 의미 |
|---:|---|---|---|
| 1 | 자동 PR 감지 | `GH_REVIEWER`에게 review request 된 open PR을 polling | 사람이 매번 봇을 호출하지 않아도 리뷰 요청 흐름에 붙는다 |
| 2 | Discord 수동 트리거 | 지정 Discord 채널의 GitHub PR URL로 즉시 리뷰 실행 | “이 PR만 다시 봐줘”를 polling 주기 없이 요청할 수 있다 |
| 3 | SHA 기준 재리뷰 | 같은 PR이라도 HEAD SHA가 바뀌면 재리뷰, 같은 SHA면 skip | 이미 본 코드를 반복 리뷰하지 않고 새 commit에 다시 반응한다 |
| 4 | PR 근거 수집·레포 간 계약 확인 | diff·현재 HEAD·레포 문서·기존 리뷰를 읽고, API·공유 타입·sibling service 계약이 직접 관련된 경우에만 다른 레포의 필요한 파일을 확인 | 한 파일만 보고 추측하는 리뷰를 줄이고 실제 계약·컨벤션을 확인한다. 단, 이 cross-repo 규칙은 현재 active prompt에 명시 주입되도록 보강해야 한다 |
| 5 | 모델/실행 경로 분리 | `codex`·`claude`·`opencode` 중 review agent 선택 가능 | 모델을 바꿔도 polling·상태·게시 정책은 유지하며, 모델별 설정 오류도 시작 전에 막는다 |
| 6 | 1차 구조화 리뷰 초안 | 1차 agent가 요약·inline 후보·기존 thread 답글 후보를 구조화된 draft로 생성 | 모델의 자유 텍스트를 곧바로 게시하지 않고 이후 검증 가능한 입력으로 만든다 |
| 7 | Ponytail 보조 리뷰 pass | 별도 fresh pass가 삭제·표준 라이브러리·플랫폼 기능·불필요한 복잡도/YAGNI 관점을 검토 | 주 리뷰가 놓칠 수 있는 단순화 기회를 보되, 이를 버그처럼 강요하지 않는다 |
| 8 | 확인된 결함 / 개선 제안 분리 | 코드·요구사항 근거로 확인된 현재 문제와, trade-off가 있는 개선 의견을 별도 분류 | 리팩터링·구조 선호를 실제 오류처럼 과장하지 않는다 |
| 9 | 개선 제안 품질 계약 | 개선 제안에는 제안·이점·리스크·레포 컨벤션 근거·현재 PR/후속 작업 범위가 모두 있어야 하며 Minor만 허용 | “한 번만 쓰니 지우세요” 같은 근거 부족 지적을 걸러낸다 |
| 10 | 독립 verifier | 1차/Ponytail 후보를 만든 세션과 분리된 verifier가 실제 코드·diff를 다시 보고 유지 또는 폐기 | 한 번의 모델 판단을 그대로 신뢰하지 않는다 |
| 11 | 삭제 전용·fail-closed gate | verifier는 후보를 버릴 수만 있다. 새 댓글·새 reply·좌표 이동·severity/body 변경·결함↔개선 제안 변환은 publisher 전에 거부 | 검증 단계가 새 오판을 만들거나 낮은 severity로 우회하지 못한다 |
| 12 | 단일 GitHub write 경계 | `publishVerifiedDraft()`/publisher만 review·inline comment·thread reply를 GitHub에 쓴다 | 분석 agent에 GitHub 게시 권한을 주지 않고, 게시 정책을 코드 한 곳에서 통제한다 |
| 13 | severity·형식 강제 | Blocker/Important/Minor에 따라 review event를 코드가 정하고, GitHub Alert와 AI/bot 작성 footer를 일관되게 렌더링 | 사람 리뷰와 혼동하지 않고, 왜 막는지·어느 정도 중요한지 명확해진다 |
| 14 | 기존 thread reply도 verdict 반영 | 신규 inline comment뿐 아니라 확인된 기존 thread 답글의 severity도 최종 event/요약에 반영 | “새 댓글이 없으니 문제 없음”이라고 잘못 Approve하는 경우를 막는다 |
| 15 | 사람 답글 follow-up | 사람이 봇 inline review에 답글을 달면 감지하고, 최신 HEAD를 다시 확인한 뒤 필요할 때만 같은 thread에 답글 | 봇의 지적·사람의 반박을 일회성 댓글로 끝내지 않고 대화로 다룬다 |
| 16 | reply 관련 Discord 알림 | 사람 답글 감지와 봇 follow-up 게시를 URL·내용과 함께 Discord에 알림 | GitHub를 계속 열어보지 않아도 팀이 대화와 봇 동작을 관찰한다 |
| 17 | repo별 + 조직 공용 review memory | review thread는 제한 길이로 archive하고, 정제된 repo lesson은 해당 레포에만 참고한다. 별도 versioned config의 사람이 검토한 organization lesson은 같은 GitHub organization 전체 PR에 참고 | 레포 고유 컨벤션을 보존하면서도 공통 API·보안·배포 기준을 재사용한다. repo lesson은 공용 memory로 자동 승격하지 않는다 |
| 18 | 중복·장애 대응 state | in-flight 보호, stale lock 회수, retry 횟수, 처리 SHA, permanent skip 상태를 저장 | 멈춘 리뷰가 slot을 계속 점유하거나 같은 PR을 반복 실행하는 문제를 줄인다 |
| 19 | 게시 확인·실패 정책 | GitHub 게시 후 read-back으로 실제 반영을 확인하고, 실패 댓글은 재시도를 모두 소진했을 때 한 번만 남긴다 | 네트워크/CLI 오류 때 댓글 폭탄 대신 운영자에게는 Discord 신호, PR 작성자에게는 최종 상태만 남긴다 |
| 20 | 운영·검증 하네스 | Node/TypeScript + PM2로 지속 실행하고, Jest·build·`git diff --check`를 변경 검증에 사용 | 기능을 추가할 때마다 실행 가능성·회귀 여부를 확인하고 운영 상태를 추적한다 |

> **현재 가동 중인 예시:** PM2 인스턴스는 online이며, 최근 로그에서 1분 주기로 review-request PR을 확인하고 최근 리뷰된 27개 PR의 review-comment thread를 scan한다. 아직 활성화 후 새 사람 답글을 실제로 만나 봇이 자동 follow-up을 게시한 사례는 없다. 즉 scan/감지 경로는 실동작 중이고, 답글 게시의 실제 E2E 사례는 앞으로 검증해야 한다.

### 대표 변경 이력

- **트리거·신뢰성:** `00e5476` (SHA 재리뷰), `544fba0` (timeout/lock), `6df6bfb` (최종 실패 후 한 번만 PR 알림)
- **팀 인터페이스:** `0bca75a` (Discord 수동 실행), `9a39e3b` (실패/skip 알림 및 bot 표기)
- **실행 모델:** `8a15a26` (Claude/OpenCode 선택), `693a356` (Codex), `04a417c` (Hermes profile)
- **대화·맥락:** `0da8efd` (댓글 follow-up), `74825c0` (reply Discord 알림), `93458ef` (review memory)
- **리뷰 하네스:** `963efb7` (draft 검증), `226a845` (Ponytail), `01d5954` (GitHub Alert), `05fcb5c` (thread reply verdict 반영), `72e2128` (verifier 변조 fail-closed)

### 한 장 요약

| 영역 | 현재 기능 | 팀에 주는 의미 |
|---|---|---|
| PR 감지 | `GH_REVIEWER`에게 review request 된 open PR을 polling. 새 commit이면 HEAD SHA 기준으로 재리뷰, 같은 SHA는 skip | 중복 리뷰를 줄이고 새 변경만 다시 본다 |
| 수동 실행 | Discord 채널에 GitHub PR URL을 올려 수동 리뷰 트리거 | "이 PR만 다시 봐줘" 같은 요청이 가능하다 |
| 리뷰 엔진 | Hermes `work` profile을 통한 읽기 전용 분석 경로. Codex/Claude/OpenCode도 선택 가능 | 모델을 바꿔도 폴링·상태·게시 런타임은 유지한다 |
| 다단계 리뷰 | 1차 draft → Ponytail advisory pass → 독립 verifier → publisher | 한 번의 모델 판단을 바로 GitHub에 쓰지 않는다 |
| 독립 검증 gate | verifier는 후보를 **삭제만** 가능. 새 댓글, 좌표 이동, 결함/개선 제안 변환, severity/body/개선 근거/reply 변경은 publish 전에 fail-closed | 검증자가 오히려 새 오판을 만들거나 정책을 우회하지 못한다 |
| 확인된 결함 / 개선 제안 분리 | 실제로 확인된 결함과 trade-off가 있는 개선 의견을 분리 | 리팩터링/YAGNI 의견을 버그처럼 강요하지 않는다 |
| 개선 제안 품질 계약 | 제안·이점·리스크·레포 컨벤션 근거·적용 범위가 필수이고 Minor만 허용 | "한 번만 쓰니 지우세요" 같은 근거 부족 댓글을 막는다 |
| Ponytail pass | delete / stdlib / native / YAGNI / shrink 관점의 보조 제안. advisory·Minor 범위로 제한 | 단순화 관점은 유지하되 과도한 설계 변경 요구를 줄인다 |
| 게시 정책 | GitHub write는 `publishVerifiedDraft()` / publisher만 수행. severity에 따라 Request changes / Comment / Approve를 코드가 결정 | 분석 agent에 GitHub 쓰기 권한을 주지 않는다 |
| 사람에게 보이는 형식 | severity 요약과 GitHub Alert 형식, 모든 리뷰/인라인/답글의 AI 작성자 footer 강제 | 봇 의견의 중요도와 작성 주체를 혼동하지 않는다 |
| 상태·재시도 | in-flight 보호, 처리 SHA·retry 상태 저장, 최대 재시도 초과 시 permanent skip, 게시 후 read-back | 중복·일시 실패를 줄이고 운영 상태를 추적한다 |
| Discord 알림 | 리뷰 시작·완료·실패·skip, 사람 답글 감지, 봇 후속 답글 게시를 알림 | GitHub만 보지 않아도 봇 동작을 관찰할 수 있다 |
| 댓글 follow-up | 사람이 봇 review thread에 답글을 달면 감지 → 최신 HEAD 기준 재검토 → 필요한 경우 스레드에 후속 답글 | 반박/설명을 일회성으로 흘리지 않고 리뷰 대화를 이어간다 |
| Review Memory | review thread 원문은 제한 길이로 archive, 정제된 lesson은 repo별로 다음 review prompt에 주입. 사람이 검토한 versioned organization Markdown wiki는 같은 GitHub organization 전체 PR에 별도 주입 | 레포별 확정 사례를 보존하면서 공통 API·보안·배포 기준도 재사용한다. 서로 다른 organization이나 raw thread는 공유하지 않는다 |
| 운영 | Node.js + TypeScript + PM2, build/test 후 재시작, runtime state와 로그를 git 제외 | 지속 실행·상태·로그 책임이 명확하다 |

### 현재 동작 중인 흐름

```text
GitHub review request / Discord PR URL
  → HEAD·state 확인 (동일 SHA skip)
  → Hermes 1차 리뷰 초안 (GitHub read-only)
  → Ponytail 보조 제안
  → 독립 verifier가 후보를 재검증·삭제
  → 코드 gate가 immutable candidate 계약을 검사
  → local publisher만 GitHub review/comment/reply 작성
  → GitHub read-back + state 저장 + Discord 알림
```

댓글 follow-up은 별도 경로다.

```text
사람이 봇의 review thread에 답글
  → Discord 알림
  → 현재 PR HEAD / 코드 재확인
  → 필요 시 같은 thread에 봇 답글
  → 대화 archive + 승인된 lesson만 해당 repo memory에 반영 (organization wiki로 자동 승격하지 않음)
```

2026-08-06 현재 reply monitor는 활성화되어 있으며 최근 reviewed PR을 1분 주기로 스캔한다.

### 실제 리뷰는 이렇게 한다

봇은 "코드가 마음에 드는가"를 보는 것이 아니라, 아래 순서로 **현재 PR에서 근거가 확인되는 문제만** 찾는다.

1. **PR의 의도를 먼저 확인한다**
   - PR 제목·설명·커밋 메시지에서 요구사항을 체크리스트로 정리한다.
   - diff가 그 요구사항을 실제로 충족하는지 대조한다.

2. **변경 코드의 실제 맥락을 읽는다**
   - diff뿐 아니라 호출자·임포트 체인·관련 타입·기존 방어 로직·레포 문서를 확인한다.
   - 기존 봇/사람 리뷰를 읽어 같은 말을 새 댓글로 반복하지 않는다.
   - 재리뷰라면 이전 리뷰 SHA 이후 새 변경을 우선 보되, PR 전체 맥락도 함께 확인한다.

3. **리뷰할 가치가 있는 범주에 집중한다**
   - 버그·요구사항 불일치·에러 처리·null/경계값
   - 보안·인증/권한·민감 데이터
   - 데이터 손상·API/타입 계약 위반
   - 실제 성능 병목·운영 위험
   - 레포 기존 패턴과 충돌하는 유지보수 위험

4. **아래는 원칙적으로 댓글을 남기지 않는다**
   - 공백·들여쓰기·import 순서·이름 취향 같은 스타일
   - "테스트가 없으니 추가해 달라"는 자동 지적
   - 로컬 의존성 미설치 등 리뷰 실행 환경의 실패
   - 코드·요구사항 근거가 없는 추측성 성능/리팩터링 의견

5. **댓글 하나에도 최소 근거를 요구한다**
   - PR에서 실제로 변경된 정확한 라인을 가리킨다.
   - 무엇이 어떻게 잘못되는지와 영향 범위를 설명한다.
   - 고칠 방법을 구체적으로 제시한다.
   - 확신이 부족하면 댓글을 쓰지 않는다. "이슈 없음"도 정상적인 리뷰 결과다.
   - PR에 테스트 코드가 포함되어 있으면 테스트 자체의 잘못된 단언이나 버그도 검토한다.

6. **개선 제안은 결함처럼 다루지 않는다**
   - 실제로 확인된 결함은 Blocker/Important/Minor가 될 수 있다.
   - 단순화·YAGNI·구조·가독성·조건부 성능처럼 정답이 하나가 아닌 의견은 개선 제안으로만 남긴다.
   - 개선 제안은 항상 Minor이며, 이점·리스크·레포 근거·적용 범위를 모두 설명해야 한다.
   - Ponytail은 이 개선 제안만 별도 관점에서 찾고, 보안·정확성·테스트 누락 같은 일반 리뷰 영역에는 개입하지 않는다.

7. **다른 세션이 다시 반증한다**
   - 독립 verifier가 실제 코드·framework 기본값·설정·테스트·기존 방어 로직을 다시 읽어 후보를 검증한다.
   - 100% 확신할 수 없거나, 기존 댓글과 중복되거나, 현재 코드에서 재현되지 않으면 후보를 버린다.
   - verifier는 더 좋은 문구로 고치거나 새 이슈를 추가하지 않고, 통과시킬 후보를 삭제하는 역할만 한다.

8. **심각도는 코드가 최종 결정한다**
   - **Blocker:** merge 전 고쳐야 하는 실제 결함·요구사항 위반 → `Request changes`
   - **Important:** 실제 문제가 있지만 merge를 반드시 막을 정도는 아님 → `Comment`
   - **Minor 또는 이슈 없음:** 개선 의견만 있거나 문제 없음 → 현재는 `Approve`
   - 단, 봇의 `Approve`를 merge approval로 인정할지는 팀이 별도로 결정한다.

### 실제 동작 설정·스킬·권한 경계

#### 현재 실행 설정 (secret 제외)

| 설정 | 현재 값 | 의미 |
|---|---:|---|
| `POLL_INTERVAL_MIN` | 1분 | review request PR과 reply monitor를 확인하는 주기 |
| `REVIEW_AGENT` | `hermes` | PR 분석에 사용하는 실행 agent |
| `HERMES_PROFILE` | `work` | provider 인증과 terminal backend를 가진 분석 profile |
| `REVIEW_TIMEOUT_MIN` | 50분 | PR 하나의 분석 시간이 넘으면 종료하는 상한 |
| `SHUTDOWN_GRACE_TIMEOUT_MIN` | 기본 155분 | SIGTERM/SIGINT 뒤 새 리뷰를 막고 진행 중 primary·Ponytail·verifier·게시·reply 작업을 drain하는 상한. PM2 hard-kill은 4시간 |
| `REVIEW_CONCURRENCY` | 기본 3 | 동시에 분석할 PR 최대 수 |
| `REPLY_MONITOR_ENABLED` | `true` | 봇 댓글에 달린 사람 답글을 감지·후속 검토 |
| `REPLY_MONITOR_LOOKBACK_DAYS` | 기본 14일 | reply monitor가 최근에 검토한 PR을 보는 범위 |
| `REVIEW_MEMORY_ENABLED` | 기본 `true` | 정제된 레포별 lesson과 organization wiki를 다음 리뷰에 참고 |
| `REVIEW_MEMORY_MAX_LESSONS` | 기본 8개 | 한 PR의 1차 agent에 넣는 repo lesson 최대 수 |
| `REVIEW_WIKI_DIRECTORY` | 기본 `docs/review-wiki` | PR로 검토하는 organization 공용 Markdown wiki 경로. `<organization>.md`의 `owner:`가 같은 GitHub organization일 때만 1차 draft에 주입 |
| `REVIEW_MEMORY_RETENTION_DAYS` | 기본 180일 | 원문 review discussion archive 보관 기간 |
| `STATE_RETENTION_DAYS` | 90일 | 완료된 PR 처리 상태 보관 기간 |

GitHub token, Discord webhook, bot token 같은 secret 값은 문서·로그·리뷰 프롬프트에 넣지 않는다.

#### PR 하나를 분석할 때 만드는 세 개의 독립 세션

현재 Hermes 모드에서는 PR 하나마다 아래 세 세션을 차례로 실행한다.

```text
1. 1차 리뷰어
   - 요구사항·diff·실제 코드·기존 리뷰·레포 문서를 읽어 후보만 작성

2. Ponytail 보조 리뷰어
   - 단순화·불필요한 복잡도만 별도 관점으로 검토

3. 독립 verifier
   - 1·2번 후보를 실제 코드로 다시 반증하고, 확실한 항목만 남김
```

- 각 세션의 역할 계약은 GitHub POST 금지·후보 JSON만 반환이며, Hermes에는 terminal tool만 노출한다.
- Hermes `work` profile은 로컬 PR clone 대신 해당 backend에서 인증된 `gh`의 **읽기(GET) 탐색 정책**으로 PR·diff·관련 파일을 확인한다.
- 분석 child process에는 로컬 publisher의 `GH_TOKEN`/`GITHUB_TOKEN` 같은 GitHub write credential을 전달하지 않는다. 다만 profile 자체의 GitHub 권한도 전용 운영 전환 시 read-only 최소 권한으로 별도 분리해야 한다.
- 마지막 publisher만 검증 통과 결과를 GitHub에 쓴다.

#### “스킬”은 현재 어떻게 쓰는가

`kungbi-pr-review` 스킬은 사람이 Hermes에게 PR 리뷰를 직접 요청할 때 참고할 수 있는 **일반 리뷰 체크리스트**다. 정확성·보안·성능·신뢰성·유지보수성·아키텍처 관점을 담고 있다.

다만 **현재 자동 리뷰봇은 이 스킬을 이름으로 명시 호출해서 동작하지 않는다.** 봇의 실제 정책은 아래 코드 계약에 고정되어 있다.

- `review-draft.ts`: 1차 리뷰·Ponytail·verifier의 리뷰 기준과 JSON 출력 계약
- `review-verification-gate.ts`: 1차 → Ponytail → verifier 순서와 fail-closed 통과 조건
- `review-publisher.ts`: GitHub 게시·severity·AI 작성자 표기 경계
- `review-executor.ts`: SHA 재리뷰·memory 주입·게시 확인·상태·Discord 알림 연결

즉 지금은 **스킬 하나의 자유로운 지시보다 코드로 고정한 리뷰 정책이 우선**이다. 팀이 합의한 레포별 규칙, Slack 결정, 금지 패턴은 향후 `reviewbot` 전용 profile의 versioned context/skill로 관리하되, severity·게시 권한·검증 gate처럼 깨지면 안 되는 규칙은 계속 코드에 둔다.

#### 리뷰 루브릭: PR에서 무엇을 실제로 확인하는가

자동 리뷰의 기본 루브릭은 아래다. 모든 PR에 체크리스트를 기계적으로 전부 적용하는 것이 아니라, **이번 변경의 코드·도메인·실행 경로와 관련 있는 항목만 실제 근거로 확인**한다.

| 우선순위 | 확인하는 내용 | 예시 |
|---|---|---|
| 1. 요구사항 | PR이 약속한 동작을 실제로 구현했는지 | PR 설명에는 취소 API 추가라고 되어 있는데 route/권한/응답 계약이 빠진 경우 |
| 2. 정확성 | 현재 코드가 잘못 동작하거나 예외가 나는지 | null/경계값, 잘못된 기본값, 비동기 오류 누락, 잘못된 조건 분기 |
| 3. 보안·권한 | 변경이 인증·인가·입력 검증·민감 정보에 영향을 주는지 | 다른 사용자의 resource ID 접근, 권한 없는 상태 변경, injection·경로 조작 |
| 4. 데이터·호환성 | DB/API/타입/이벤트 계약을 깨지 않는지 | migration 누락, nullable 의미 변경, 클라이언트 응답 형식 변경, 데이터 유실 |
| 5. 신뢰성·운영 | 장애 상황·재시도·타임아웃·로그·자원 사용이 실제로 위험한지 | 오류를 삼켜 복구 불가, 무한 재시도, N+1, 실제 memory leak 가능성 |
| 6. 유지보수성 | 기존 레포 패턴·책임·도메인 계약을 깨는지 | 이미 있는 DI/DTO/정책 패턴과 충돌하거나 한 변경이 숨은 invariant를 무너뜨리는 경우 |

#### 스택별 보조 체크리스트

`kungbi-pr-review` 스킬에는 아래 보조 체크리스트도 있다. 단, 현재 자동 봇에 이 스킬을 명시 주입하는 구조는 아니므로, 팀이 원하면 이를 repo별 versioned rule로 승격할 항목을 정한다.

- **TypeScript/JavaScript:** null/undefined, async 오류 처리, 무분별한 type assertion, DI 패턴
- **Python:** 구체적인 예외 처리, async/await, type hint, dependency 선언 일치
- **Go/Kubernetes:** error return, context 전파·취소, goroutine leak, client-go watcher, manifest/RBAC/Pod security/resource limit
- **보안:** object/function-level authorization, secret 노출, injection, SSRF, secure default, 로그의 개인정보·credential 노출

#### 댓글을 남기는 최소 기준

댓글은 아래를 모두 만족해야 한다.

1. **변경된 정확한 줄**을 가리킨다.
2. **현재 어떤 입력·상태·실행 경로에서 문제가 재현되는지** 설명한다.
3. **영향**을 설명한다. 예: 데이터 유실, 권한 우회, 500 응답, 호환성 깨짐.
4. 가능한 경우 **구체적인 수정 방향**을 제시한다.
5. 기존 댓글과 중복이면 새 inline comment 대신 같은 thread에 필요한 근거만 추가한다.
6. 실제 근거가 부족하면 댓글을 남기지 않는다.

반대로 스타일 취향, 파일/줄 수 감소만을 이점으로 하는 리팩터링, 실행하지 못한 로컬 환경의 오류는 댓글 대상이 아니다.

#### 레포 간 계약 확인 (cross-repo lookup)

이것도 명시된 리뷰 원칙이다. 다만 **모든 PR에서 다른 레포를 넓게 검색하는 기능이 아니라**, 아래 상황에서만 필요한 계약을 확인하는 방식이다.

- API 요청/응답 계약을 바꾸는 PR
- 공유 타입·SDK·이벤트 schema를 바꾸는 PR
- 여러 service가 함께 쓰는 migration·queue·outbox·auth 규칙을 바꾸는 PR
- sibling service의 실제 호출 방식과 이번 변경의 호환성을 확인해야 하는 경우

확인 방법은 다음처럼 제한한다.

1. **같은 GitHub organization 안에서만** 확인한다.
2. 해당 계약과 직접 관련된 **필요한 파일만** 읽는다. 레포 전체 clone·광범위 탐색은 하지 않는다.
3. PR의 base branch와 **같은 branch/ref**를 기준으로 파일을 읽는다. PR base가 `main`이면 다른 레포도 `main`을 명시하며, 오래된 default/master를 근거로 판단하지 않는다.
4. 500KB를 넘는 파일은 읽지 않는다.
5. GitHub token/설치 권한과 repository allowlist 범위를 넘어서 조회하지 않는다.

예를 들면, API 서버 PR에서 DTO나 응답 형식을 바꿨을 때 실제 client·worker·sibling API가 어떤 타입/필드를 쓰는지 해당 파일만 확인한다. 이것은 "다른 레포도 전부 검사"하는 것이 아니라, **이번 변경이 깨뜨릴 수 있는 계약을 확인하기 위한 제한적 조회**다.

**현재 구현 상태를 정확히 말하면:** README와 `kungbi-pr-review` 스킬에는 위 cross-repo 정책이 명시돼 있다. 하지만 현재 검증형 자동 리뷰의 실제 실행 경로는 `review-draft.ts` prompt를 사용하고, 이 prompt에는 위의 branch/ref·파일 크기·필요 파일만 조회 규칙이 아직 명시적으로 들어가 있지 않다. 따라서 지금은 "문서화된/사용 가능한 리뷰 원칙"이지, **모든 자동 리뷰에서 코드로 강제되는 동작이라고 표현하면 안 된다.**

팀 운영 전에는 이 규칙을 active review prompt와 repository allowlist 양쪽에 넣어, 레포 간 조회가 필요할 때는 정확히 수행하고 필요하지 않을 때는 하지 않도록 보강하는 것이 맞다.

---

## 3. 지금 구조에서 잘된 점과, 더 필요한 점

### 좋았던 점 — 유지할 것

1. **분석과 게시가 분리되어 있다.**
   - Hermes는 분석 JSON만 돌려주고, GitHub POST는 로컬 publisher만 할 수 있다.
2. **독립 verifier와 fail-closed gate가 있다.**
   - 모델 답변을 믿는 대신 코드가 게시 전 계약을 검사한다.
3. **개선 제안을 실제 오류와 분리했다.**
   - 확신이 낮은 리팩터링 의견이 Blocker/Important로 과장되지 않게 했다.
4. **사람의 반박을 다음 리뷰 품질에 반영할 기반이 있다.**
   - repo-scoped review memory가 “문제 아님”으로 정리된 사례와 컨벤션을 저장한다.
5. **운영 관찰성이 있다.**
   - PM2 상태, GitHub read-back, retry/state, Discord 알림으로 문제를 추적할 수 있다.

### 필요한 점 — 우선순위로 합의할 것

1. **전용 봇 신원·권한·운영자 분리**
   - 개인 GitHub 계정/토큰/개인 Hermes profile에 계속 묶여 있으면 인수인계와 감사가 어렵다.
2. **명시적인 repo allowlist**
   - 현재 자동 범위는 `review request + token 접근 권한`의 교집합이다. 어떤 조직/레포를 봐도 되는지 코드와 설정으로 제한해야 한다.
3. **팀 관리형 컨텍스트 소스 확장**
   - organization 공용 memory는 versioned config로 같은 organization 전체 PR에 주입할 수 있게 했다. 다만 아키텍처 원칙, 서비스 경계, 금지 패턴, 테스트/배포 규칙, 관련 Slack 의사결정은 repo별로도 명시적으로 관리·검색하는 경로가 더 필요하다.
4. **reply monitor의 durable idempotency**
   - 현재 프로세스 내 중복 방지와 두 번의 HEAD 확인은 있지만, POST 응답 유실·프로세스 재시작까지 정확히 한 번의 답글을 보장하지는 않는다. outbox + GitHub 원격 reconcile이 필요하다.
5. **follow-up agent 격리 강화**
   - 현재 child process에서 GitHub 토큰 환경변수는 제거하지만, HOME/cwd/나머지 환경 상속을 최소 허용목록 방식으로 더 좁혀야 한다.
6. **배포 단위 정리**
   - 활성화된 reply-monitor 관련 변경과 구조도는 아직 별도 commit/review가 필요하다. 전용 인스턴스 전환 전에는 dirty worktree build가 아닌, commit SHA 기반 release 절차로 고정해야 한다.
7. **공식 승인 권한 정책**
   - 현재는 Blocker가 있으면 Request changes, Important면 Comment, Minor/없음이면 Approve 이벤트를 낸다. 봇의 `Approve`를 merge approval로 인정할지, 항상 Comment-only로 둘지 팀 정책이 필요하다.

---

## 4. 제안 운영 모델

```text
[GitHub App: Kungbi PR Reviewer]             [팀원]
  설치된 repo에만 접근                         리뷰 요청 / Discord 수동 요청
  Pull requests read/write                                  │
  Contents read / Metadata read                              ▼
                 │                                  [Discord 알림]
                 ▼
[전용 pr-reviewer-bot 인스턴스]
  Node + PM2, 단일 active instance
  state / logs / deploy 책임
  GitHub write는 publisher만
                 │
                 ▼
[전용 Hermes profile: reviewbot]
  GitHub read-only 분석
  repo별 approved context retrieval
  개인 home/work 메모리와 분리
  draft / verifier / follow-up 판단
```

### 4-1. GitHub 신원: 전용 계정보다 GitHub App을 기본안으로 권장

**권장안: 조직 소유 GitHub App** (예: `Kungbi PR Reviewer`)을 필요한 repository에만 설치한다.

- GitHub App은 installation별 repo 범위와 권한을 분리할 수 있다.
- App installation token은 GitHub 문서 기준 1시간 후 만료되므로, 장기 PAT를 한 번 넣어두는 방식보다 노출 범위를 줄일 수 있다.
- GitHub App bot은 Enterprise license를 소비하지 않는 반면, machine user는 개인 계정 계열이라 license·2FA·공용 이메일·토큰 교체를 별도 운영해야 할 수 있다.
- GitHub 활동이 `... [bot]`으로 남아 사람 리뷰와 구분된다.
- App manager를 조직 내 여러 명에게 부여해 개인 퇴사/휴가/2FA 변경에 덜 의존한다.

**필요 최소 권한 초안**

| 권한 | 목적 |
|---|---|
| Metadata: Read | 설치된 repository 기본 메타데이터 |
| Contents: Read | 변경 파일·관련 코드·repo 문서 read |
| Pull requests: Read/Write | PR 조회, review, inline comment, review-comment reply |
| Issues: Read (필요할 때만) | PR conversation의 issue comment까지 읽어야 할 경우 |

`Administration`, `Actions`, `Workflows`, `Secrets`, 조직 관리, git push 권한은 초기 범위에 넣지 않는다.

**중요한 구현 확인**

현재 trigger는 `review-requested:<GH_REVIEWER>` polling이다. GitHub App bot을 실제 reviewer로 지정·검색할 수 있는지 sandbox PR에서 먼저 검증해야 한다. 맞지 않으면 App webhook(`pull_request`, `pull_request_review_comment`)이나 Discord 수동 trigger를 기준으로 전환한다. App 전환은 단순히 `.env`의 token만 바꾸는 작업이 아니라, 1시간짜리 installation token을 자동 발급·교체하는 token provider를 추가하는 작업이다.

### 4-2. 대안: 전용 machine user

빠른 PoC에는 `kungbi-pr-reviewer-bot` 같은 전용 GitHub user와 fine-grained PAT를 쓸 수 있다. 현 polling 구조를 비교적 적게 바꿀 수 있다는 장점이 있다.

다만 다음 운영 부담이 있다.

- 공용 이메일, 2FA, recovery code, 로그인 가능한 운영자 관리
- 토큰 만료·폐기·교체 책임
- 조직 license/seat 정책 확인
- 권한이 개인 user 단위로 넓어지기 쉬움

따라서 **빠른 검증은 machine user**, **장기 운영은 GitHub App**을 권장한다.

### 4-3. 전용 인스턴스와 프로필

- 봇 전용 checkout / PM2 app / 환경변수 / 로그 / state 디렉터리를 둔다.
- 첫 단계는 **단일 active instance**만 운영한다. 현재 state가 local JSON이므로 복수 active instance는 중복 게시 위험이 있다.
- 배포는 `clean commit SHA → npm ci → test → build → PM2 restart → health/log 확인`으로 고정한다. `.env`, state, logs, build artifact는 commit하지 않는다.
- `reviewbot` Hermes profile은 개인 `home-work`/`work` 맥락과 분리한다. 분석 agent에는 publisher credential을 전달하지 않는다.
- state와 review memory는 repo/환경별로 분리하고, runtime data 접근 가능한 운영자를 정한다.

---

## 5. "맥락을 아는 봇"을 만드는 방식

기억을 무작정 많이 넣는 방식은 답이 아니다. 개인적인 대화나 다른 프로젝트 맥락이 섞이면 오히려 품질과 보안이 나빠진다.

### 목표 컨텍스트 우선순위

1. **PR 자체 근거**: diff, 최신 HEAD, 테스트, 실제 실행 경로
2. **레포의 명시 문서**: `README`, `AGENTS.md`, `CLAUDE.md`, architecture docs, CODEOWNERS, API/DB 계약
3. **팀이 승인한 organization-wide review context**
   - 공통 API/보안/배포 원칙처럼 같은 GitHub organization 전체에 적용되는 기준
   - versioned Markdown wiki를 PR로 검토해 관리하고, 다른 organization에는 절대 보내지 않음
4. **팀이 승인한 repo-scoped review context**
   - 서비스 경계와 책임
   - 금지하는 설계/보안 패턴
   - 테스트·배포·마이그레이션 규칙
   - 과거에 봇이 지적했지만 팀이 “문제 아님”으로 확인한 사례와 그 이유
5. **review thread에서 검증된 lesson**
   - “문제 아님”, 팀 컨벤션, 유효한 지적 등으로 정제된 항목만
   - repo lesson은 organization wiki로 자동 승격하지 않음

### 현재 적용 상태와 팀 운영 목표

“맥락을 읽는다”는 표현을 과장하지 않기 위해, 현재 검증형 자동 파이프라인에서 **코드로 명시된 범위**와 팀 운영 시 **반드시 추가할 범위**를 구분한다.

| 맥락 | 현재 검증형 자동 리뷰 | 팀 운영 전 보강할 점 |
|---|---|---|
| PR 제목·설명·커밋·diff·기존 review/thread | ✅ 1차/검증 prompt에 명시 | 유지 |
| 실제 관련 코드, framework/DTO/default/config/기존 방어 로직 | ✅ verifier가 재확인하도록 명시 | 영향 경로 탐색 범위를 repo별로 정교화 |
| 사람 답글에서 정제된 repo memory + 사람이 검토한 organization wiki | ✅ repo lesson과 같은 GitHub organization 공용 Markdown을 **1차 draft prompt에 분리 주입**. raw thread·다른 organization은 제외 | repo별 versioned context와 path/서비스 영역 검색을 확장 |
| `README`·`AGENTS.md`·`CLAUDE.md`·architecture 문서 | ⚠️ 목표/기존 direct prompt에는 있으나, 현재 검증형 prompt에는 명시 강제가 아님 | 문서 경로와 우선순위를 repo context로 versioning |
| 시스템 전체 구조·서비스 경계 | ⚠️ 1차/검증자가 관련 코드에서 추론할 수는 있으나, architecture map을 자동 탐색하지는 않음 | 서비스·API·이벤트·DB 의존성 map을 curated context로 제공 |
| Docker/CI/Terraform/Helm/Kubernetes 등 인프라 파일 | ⚠️ `kungbi-pr-review` 스킬에 체크리스트는 있으나, 현재 자동 prompt에 명시 주입되지 않음 | 해당 경로가 바뀐 PR에서는 infra rubric을 반드시 적용 |
| sibling repo 계약 | ⚠️ README/스킬에는 정책이 있으나 active prompt 보강 필요 | base-ref 조회·allowlist를 코드/정책으로 강제 |
| PR에 링크된 Slack 결정 thread | ❌ 아직 읽지 않음 | 전용 read-only bot/OAuth와 permalink 방식으로 추가 |

### 인프라·전체 구조는 언제, 어디까지 읽는가

봇이 “전체 구조를 안다”는 것은 모든 레포와 파일을 전부 읽는다는 뜻이 아니다. **PR이 바꾸는 경계와 배포 경로에 필요한 구조만** 확인한다.

#### 애플리케이션/서비스 경계 변경

API, worker, event, queue, outbox, cron, DB, 외부 provider 중 하나를 바꾸면 가능한 범위에서 다음 흐름을 함께 본다.

```text
요청/이벤트 진입점 → 도메인 처리 → DB·cache·queue/outbox → 외부 서비스·응답 소비자
```

- 요청/응답, 이벤트 schema, retry/idempotency, timeout, error handling, 데이터 migration·rollback, 이전 client와의 호환성
- 설정값의 source·기본값·validation과 실제 production 경로
- 관련 architecture 문서나 approved context가 있으면 그것을 현재 코드·HEAD와 함께 대조

#### 인프라/배포 파일 변경

`Dockerfile`, `.github/workflows/`, Terraform/Cloud 설정, Helm/Kubernetes manifest, 운영 config가 바뀌는 PR이면 해당 파일 자체가 리뷰 대상이다. 관련 있는 항목만 다음을 확인한다.

- **권한·secret:** hard-coded credential 금지, 최소 권한 RBAC/IAM, secret이 로그·환경에 불필요하게 노출되지 않는지
- **실행 안전성:** image tag/공급망, non-root/privileged 설정, resource request/limit, health/readiness probe
- **네트워크:** 필요한 ingress/egress만 열려 있는지, host network/port·과도한 공개가 없는지
- **배포·운영:** environment별 기본값, timeout/retry, migration 순서·rollback, CI가 배포 대상 branch/환경을 잘못 선택하지 않는지
- **관측성:** 실패가 원인 없이 숨겨지지 않고, 민감정보 없이 필요한 로그·alert 신호가 남는지

이 범위는 `kungbi-pr-review` 스킬의 Kubernetes/보안/테스트 체크리스트에도 이미 있는 내용이다. 다만 현재 자동 봇에는 항상 적용된다고 말할 수 없으므로, 전용 팀 봇 전환 시 **경로 기반 rubric**으로 명시하는 것이 필요하다. 예: `infra/**`, `.github/workflows/**`, `helm/**`, `k8s/**`, `terraform/**`, `Dockerfile` 변경 시 infra checklist를 활성화한다.

### 제안할 운영 원칙

- context는 repo + path + 서비스 영역으로 검색하고, 어떤 context를 썼는지 리뷰/로그에서 추적 가능하게 한다.
- 사람의 답글 원문을 자동으로 일반 규칙으로 만들지 않는다. confidence와 팀 확인을 거친 lesson만 활성화한다.
- `one_off_exception`은 그 PR의 예외로만 보며 일반 규칙으로 확대하지 않는다.
- 중요한 컨벤션은 state 파일이 아니라 팀이 review 가능한 versioned 문서/설정에서 관리한다.
- prompt가 아닌 코드 gate로도 지킬 수 있는 규칙(예: severity, disclosure, GitHub write 경계)은 코드에 둔다.

### Slack 논의를 PR 맥락으로 쓰는 방향

현재 리뷰봇은 **Slack을 읽지 않는다.** 다만 팀의 설계·정책 결정이 Slack thread에만 남는 경우가 많으므로, 아래처럼 **PR에 명시적으로 연결된 논의만** 읽는 기능을 추가하는 것이 좋다.

```md
## 관련 논의 / 결정
- Slack: https://.../archives/.../p...
- 이번 PR에 적용한 결정: 결제 취소는 provider 재시도보다 outbox 처리로 통일
```

운영 원칙:

1. 봇은 조직 전체 Slack을 광범위하게 검색하지 않고, **PR 본문에 포함된 permalink의 메시지와 해당 thread만** 읽는다.
2. Slack 논의는 현재 코드보다 우선하지 않는다. 최신 HEAD·diff·테스트로 검증하고, 논의가 오래됐거나 현재 구현과 충돌하면 질문 또는 보류로 처리한다.
3. Slack 원문은 비신뢰 데이터로 취급한다. 메시지 안의 명령·정책 변경·링크 지시를 실행하지 않는다.
4. Slack 연동은 전용 bot/OAuth identity의 read-only 권한과 허용 channel 목록으로 제한한다. private channel·민감 대화는 명시적 권한과 보관 정책 없이는 읽거나 memory에 저장하지 않는다.
5. GitHub 댓글에는 팀이 접근 가능한 경우에만 Slack permalink를 근거 링크로 표시한다. 외부 공개 PR이나 접근권한이 다른 경우에는 링크·원문을 노출하지 않고, 팀이 승인한 짧은 결정 요약만 사용한다.
6. Slack thread를 자동으로 영구 규칙으로 승격하지 않는다. 재사용할 팀 결정은 owner와 유효 기간을 가진 curated context로 팀이 승인한다.

이 방식이면 PR 작성자가 “이 변경은 이미 Slack에서 합의된 방향”을 연결할 수 있고, 봇은 그 결정을 무시하거나 반대로 과도하게 추종하지 않고 코드 근거와 함께 판단할 수 있다.

---

## 6. 단계적 도입안

### Phase 0 — 팀 합의

- GitHub App vs machine user
- 대상 repository allowlist
- 봇이 formal Approve를 낼지 여부
- follow-up reply를 언제 자동 게시할지
- review context의 작성/승인 책임자

### Phase 1 — 전용 신원·단일 인스턴스

- GitHub App 등록 또는 machine user PoC
- sandbox PR에서 review request / comment / reply / read-back 권한 검증
- 전용 secret 저장과 운영자 2명 이상 지정
- clean release 기준 PM2 instance 생성

### Phase 2 — shadow / canary

- 처음에는 1~2개 repo 또는 선택 PR만 대상으로, 결과를 Discord에 draft로 공유
- 사람 리뷰와 비교: 오탐(문제가 아닌데 지적한 사례), 누락, severity, 응답 시간, 댓글 수
- 기준 충족 후 verified publisher를 실제 GitHub 게시로 확대

### Phase 3 — 맥락 품질 고도화

- repo별 approved context 문서와 retrieval 도입
- reply-monitor durable outbox/reconcile, child env allowlist, repository allowlist 구현
- 주기적으로 오탐과 유용한 리뷰 사례를 팀이 회고

---

## 7. 팀 피드백을 받고 싶은 질문

### 제품/리뷰 품질

1. 지금까지 봇 리뷰 중 **도움 됐던 지적**, **쓸데없거나 불편했던 지적**은 무엇이었나?
2. 봇이 반드시 잡아야 하는 범주는 무엇인가? (보안, 데이터 정합성, API 호환성, 운영, 성능 등)
3. 봇이 원칙적으로 피해야 할 범주는 무엇인가? (스타일, 과도한 리팩터링, 추측성 성능 등)
4. 개선 제안 댓글에서 이점·리스크·컨벤션·범위 중 부족했던 정보는 무엇인가?
5. 봇의 Blocker / Important / Minor 기준과 봇의 formal Approve 정책에 동의하는가?

### 맥락/학습

6. 레포마다 봇에게 반드시 알려줘야 할 아키텍처·도메인·배포·테스트 규칙은 무엇인가?
7. PR 본문에 연결할 Slack 논의는 어떤 형식이어야 하며, 어느 channel/thread까지 봇이 read-only로 참고해도 되는가?
8. 봇이 사람 답글이나 Slack 논의에서 배운 내용을 자동 반영해도 되는 범위와, 팀 승인 후 반영해야 하는 범위는 무엇인가?
9. 댓글에 "잘못된 리뷰였다"라고 남겼을 때 봇이 어떤 방식으로 정정하면 신뢰하기 좋은가?

### 운영/보안

10. 개인 계정 대신 GitHub App을 쓰는 데 동의하는가? 빠른 machine user PoC가 필요할까?
11. 어느 repository부터 설치·운영할까? 명시 allowlist는 어디에서 관리할까?
12. 봇 credential, PM2 host, 로그·state 접근을 공동으로 관리할 담당자는 누구인가?
13. 장애·중복 댓글·부정확한 리뷰가 발생했을 때 누가 중지·삭제·재처리할까?
14. 자동 follow-up reply는 어디까지 허용할까? 기술 판정은 사람이 승인해야 하는 경우가 있는가?

---

## 8. 이번 논의에서 결정하면 좋은 것

1. **장기 신원:** GitHub App을 기본안으로 채택할지
2. **초기 범위:** 1~2개 repository canary와 allowlist
3. **권한:** Pull requests write / Contents read 외 추가 권한이 필요한지
4. **게시 정책:** Comment-only로 시작할지, Blocker request changes와 Minor approve를 허용할지
5. **운영 책임:** credential·배포·중지 권한을 가진 최소 2명
6. **Slack 맥락 규칙:** PR template에 Slack permalink·결정 요약을 넣을지, 읽을 수 있는 channel과 retention을 어떻게 제한할지
7. **품질 회고 주기:** 예를 들어 2주 canary 뒤 오탐/누락 사례를 모아 policy와 context를 업데이트할지

---

## 근거 및 현재 상태 (2026-08-06)

- 현재 운영 런타임: Node.js/TypeScript + PM2 `pr-reviewer-bot`, Hermes `work` profile 기반 분석
- 검증 gate 변경 commit: `72e2128` — verifier candidate mutation fail-closed
- 검증 결과: 전체 Jest 13 suites / 112 tests, TypeScript build 통과 시점 확인
- reply monitor: 현재 활성화 상태. 대상 테스트 2 suites / 15 tests와 build 통과 후 PM2 online 및 live scan 확인
- 별도 commit/review가 필요한 현재 작업트리: reply-monitor hardening WIP와 구조도 문서
- GitHub 문서 참고:
  - [GitHub App installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) — installation token 1시간 만료
  - [GitHub Apps vs OAuth apps](https://docs.github.com/enterprise-cloud@latest/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps) — App bot과 machine user의 운영 차이
  - [Pull request review comments REST API](https://docs.github.com/en/rest/pulls/comments) — Pull requests 권한 모델
