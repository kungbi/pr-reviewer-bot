'use strict';

/**
 * Build the analysis prompt for PR review.
 *
 * The prompt embeds the full diff text so the agent does not need
 * to fetch it again – keeping the flow synchronous from our side.
 *
 * @param {object} params
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {number} params.prNumber
 * @param {string} params.prTitle
 * @param {string} params.prUrl
 * @param {string} params.diff - Raw unified diff text
 * @returns {string} Prompt string
 */
function buildAnalysisPrompt({ owner, repo, prNumber, prTitle, prUrl, diff }) {
  return `You are using the kungbi-pr-review skill to review a GitHub Pull Request.

## PR Info
- Repository: ${owner}/${repo}
- PR Number: #${prNumber}
- Title: ${prTitle}
- URL: ${prUrl}

## Diff
\`\`\`diff
${diff}
\`\`\`

## Instructions
Analyze the diff above and produce a structured review. Each issue you raise will be posted as an **inline comment** directly on the relevant line, so the per-issue body must be self-contained and detailed.

1. Review across all 6 axes:
   - Correctness (logic errors, edge cases, null handling)
   - Security (injection, auth bypass, sensitive data exposure)
   - Performance (N+1 queries, unnecessary loops, memory leaks)
   - Reliability (error handling, timeouts, retries)
   - Maintainability (code duplication, dead code, naming)
   - Architecture (coupling, design patterns)

2. Severity levels:
   - Blocker: security vulnerabilities, data corruption, crash risk
   - Important: bugs, performance degradation, bad validation
   - Minor: code smells, maintainability

3. For EVERY issue, include the following fields (write in Korean):
   - **[근거]** 관련 규칙/표준 (OWASP, CWE, RFC 등) — URL도 포함
   - **문제** 이 코드가 왜 문제인지
   - **영향** 실제로 발생할 수 있는 결과
   - **수정 제안** 구체적 수정 방법 (가능하면 코드 예시 포함)

4. Output format (write EVERYTHING in Korean):

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
- 모든 이슈에 근거, 문제, 영향, 수정 제시안 4개 필드 빠짐없이 작성
- 출력은 한국어로만 작성`;
}

module.exports = { buildAnalysisPrompt };
