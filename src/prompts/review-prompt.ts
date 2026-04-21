
/**
 * Build the analysis prompt for PR review.
 */

interface ReviewPromptParams {
  owner: string;
  repo: string;
  prNumber: number;
}

export function buildAnalysisPrompt({ owner, repo, prNumber }: ReviewPromptParams): string {
  return `${owner}/${repo} 레포지토리의 PR #${prNumber} 를 리뷰해줘.

gh pr view, gh pr diff, gh api 등을 사용해서 직접 탐색해:
- PR 설명과 제목을 먼저 읽고 비즈니스 요구사항을 파악해
- 변경된 파일의 전체 내용을 읽어 컨텍스트를 이해해
- PR 설명의 요구사항과 실제 코드가 일치하는지 확인해

리뷰 결과는 반드시 아래 형식으로 출력해 (한국어로):

## PR Review

### Blockers
**path/to/file.ext:lineNumber** 🔴 Blocker
[근거: 규칙명](URL)
**문제**: 설명
**영향**: 결과
**수정 제안**: 수정 방법

### Important
**path/to/file.ext:lineNumber** 🟡 Important
(같은 형식 — 없으면 "없음")

### Minor
**path/to/file.ext:lineNumber** 🟢 Minor
(같은 형식 — 없으면 "없음")

### Verdict
(1개 이상 blocker → ❌ BLOCKED | blocker 0 + important 1개+ → ⚠️ NEEDS WORK | blocker/important 0 → ✅ APPROVED)

IMPORTANT:
- **file:line 형식의 헤더가 반드시 필요** — 없으면 인라인 코멘트로 등록 불가
- 모든 이슈에 근거, 문제, 영향, 수정 제안 4개 필드 빠짐없이 작성
- PR 설명의 비즈니스 요구사항과 코드가 다르면 반드시 Blocker로 보고`;
}
