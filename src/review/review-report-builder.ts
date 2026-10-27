import type {
  ReviewChange,
  ReviewEvidence,
  ReviewFinding,
  ReviewReport,
  ReviewTestRunner,
} from '../types/review-report.types';
import type { ReviewDraft } from './review-draft';
import type { ReviewTestRunnerResult } from './review-test-runner';

const MAX_DIFF_BYTES = 4_000_000;
const MAX_CHANGES = 30;
const MAX_CHANGED_LINES_PER_SIDE = 4;
const MAX_SNIPPET_LENGTH = 400;
const MAX_REPORT_TEXT_LENGTH = 2_000;
const MAX_REVIEW_FINDINGS = 120;
const MAX_DECISION_OPTIONS = 30;
const INVALID_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

interface ChangedLine {
  line: number;
  text: string;
}

interface HunkCapture {
  oldPath?: string;
  newPath?: string;
  path: string;
  oldLines: ChangedLine[];
  newLines: ChangedLine[];
  oldLine: number;
  newLine: number;
  expectedOld: number;
  expectedNew: number;
  consumedOld: number;
  consumedNew: number;
  changedOldCount: number;
  changedNewCount: number;
}

interface ParsedDiff {
  changes: ReviewChange[];
  totalHunks: number;
  totalMetadata: number;
  unrepresentedSections: number;
  unrepresentedPaths: string[];
}

function nonTextualChange(block: string, owner: string, repository: string, pullRequestNumber: number): ReviewChange | undefined {
  // A complete, recognized metadata-only section is required. Never treat a
  // truncated hunk or unknown patch syntax as evidence of absent text.
  const lines = block.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const header = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[0] ?? '');
  if (!header || !isSafeRepositoryPath(header[1]) || !isSafeRepositoryPath(header[2])) return undefined;
  const [, oldPath, newPath] = header;
  const body = lines.slice(1);
  let kind: ReviewChange['nonTextual'];
  if (body.length === 2 && /^old mode [0-7]{6}$/.test(body[0]) && /^new mode [0-7]{6}$/.test(body[1]) && oldPath === newPath && body[0].slice(9) !== body[1].slice(9)) {
    kind = 'mode';
  } else if (body.length === 3 && body[0] === 'similarity index 100%' && body[1] === `rename from ${oldPath}` && body[2] === `rename to ${newPath}` && oldPath !== newPath) {
    kind = 'rename';
  } else if (body.length === 2 && /^index [0-9a-f]+\.\.[0-9a-f]+(?: [0-7]{6})?$/.test(body[0]) && body[1] === `Binary files a/${oldPath} and b/${newPath} differ`) {
    kind = 'binary';
  } else if (oldPath === newPath && body.length === 3 && /^new file mode [0-7]{6}$/.test(body[0]) && /^index 0+\.\.[0-9a-f]+$/.test(body[1]) && body[2] === `Binary files /dev/null and b/${newPath} differ`) {
    kind = 'binary';
  } else if (oldPath === newPath && body.length === 3 && /^deleted file mode [0-7]{6}$/.test(body[0]) && /^index [0-9a-f]+\.\.0+$/.test(body[1]) && body[2] === `Binary files a/${oldPath} and /dev/null differ`) {
    kind = 'binary';
  }
  if (!kind) return undefined;
  const detail = body.join('; ');
  return {
    title: `${kind} metadata in ${(oldPath === newPath ? newPath : `${oldPath} → ${newPath}`).slice(0, 200)}`,
    nonTextual: kind,
    evidence: [{ kind: 'diff', label: 'GitHub PR diff metadata', detail, path: newPath, url: `https://github.com/${owner}/${repository}/pull/${pullRequestNumber}/files` }],
  };
}

function isSafeRepositoryPath(value: string): boolean {
  return value.length > 0
    && value.length <= 500
    && !value.startsWith('/')
    && !value.includes('\\')
    && !/[\u0000-\u001F\u007F]/.test(value)
    && !value.split('/').some((segment) => segment === '..' || segment === '.');
}

function decodeGitPath(rawValue: string, prefix: 'a/' | 'b/'): string | undefined {
  const raw = rawValue.split('\t', 1)[0];
  if (raw === '/dev/null') return undefined;
  let decoded = raw;
  if (raw.startsWith('"')) {
    if (!raw.endsWith('"') || raw.length < 2) return undefined;
    decoded = '';
    const input = raw.slice(1, -1);
    for (let index = 0; index < input.length; index += 1) {
      const character = input[index];
      if (character !== '\\') {
        decoded += character;
        continue;
      }
      index += 1;
      const escaped = input[index];
      if (escaped === undefined) return undefined;
      const octal = /^[0-7]{3}$/.exec(input.slice(index, index + 3));
      if (octal) {
        decoded += String.fromCharCode(Number.parseInt(octal[0], 8));
        index += 2;
        continue;
      }
      const escapes: Record<string, string> = {
        '"': '"',
        '\\': '\\',
        t: '\t',
        n: '\n',
        r: '\r',
      };
      if (!(escaped in escapes)) return undefined;
      decoded += escapes[escaped];
    }
  }
  if (decoded.startsWith(prefix)) decoded = decoded.slice(prefix.length);
  return isSafeRepositoryPath(decoded) ? decoded : undefined;
}

function boundedSnippet(lines: ChangedLine[]): string {
  return lines
    .slice(0, MAX_CHANGED_LINES_PER_SIDE)
    .map(({ text }) => text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '\uFFFD').slice(0, MAX_SNIPPET_LENGTH))
    .join('\n');
}

function diffEvidence(
  hunk: HunkCapture,
  lines: ChangedLine[],
  side: 'LEFT' | 'RIGHT',
  owner: string,
  repository: string,
  pullRequestNumber: number,
): ReviewEvidence {
  const path = side === 'LEFT' ? (hunk.oldPath ?? hunk.path) : (hunk.newPath ?? hunk.path);
  const total = side === 'LEFT' ? hunk.changedOldCount : hunk.changedNewCount;
  const visible = lines.slice(0, MAX_CHANGED_LINES_PER_SIDE);
  const truncatedNote = total > visible.length
    ? ` 표시 한도 ${MAX_CHANGED_LINES_PER_SIDE}줄로 나머지 ${total - visible.length}줄은 생략했습니다.`
    : '';
  const textTruncatedNote = visible.some(({ text }) => text.length > MAX_SNIPPET_LENGTH)
    ? ` 줄당 문자 한도 ${MAX_SNIPPET_LENGTH}자로 일부 내용을 생략했습니다.`
    : '';
  const hasInvalidControl = visible.some(({ text }) => INVALID_CONTROL.test(text));
  const sideLabel = side === 'LEFT' ? '변경 전 제거 줄' : '변경 후 추가 줄';
  return {
    kind: 'diff',
    label: `GitHub PR diff · ${sideLabel}`,
    detail: `가져온 PR diff hunk의 ${sideLabel}을 인용했습니다.${truncatedNote}${textTruncatedNote}${hasInvalidControl ? ' 안전한 표시를 위해 제어 문자는 대체했습니다.' : ''}`,
    path,
    startLine: visible[0].line,
    endLine: visible[visible.length - 1].line,
    side,
    url: `https://github.com/${owner}/${repository}/pull/${pullRequestNumber}/files`,
  };
}

function finishHunk(
  hunk: HunkCapture | undefined,
  owner: string,
  repository: string,
  pullRequestNumber: number,
): ReviewChange | undefined {
  if (!hunk || hunk.consumedOld !== hunk.expectedOld || hunk.consumedNew !== hunk.expectedNew) return undefined;
  if (hunk.changedOldCount === 0 && hunk.changedNewCount === 0) return undefined;

  const titlePath = hunk.oldPath && hunk.newPath && hunk.oldPath !== hunk.newPath
    ? `${hunk.oldPath} → ${hunk.newPath}`
    : hunk.newPath ?? hunk.oldPath ?? hunk.path;
  const pathLabel = titlePath.length > 200 ? `${titlePath.slice(0, 197)}…` : titlePath;
  const evidence: ReviewEvidence[] = [];
  if (hunk.changedNewCount > 0) {
    evidence.push(diffEvidence(hunk, hunk.newLines, 'RIGHT', owner, repository, pullRequestNumber));
  }
  if (hunk.changedOldCount > 0) {
    evidence.push(diffEvidence(hunk, hunk.oldLines, 'LEFT', owner, repository, pullRequestNumber));
  }
  const before = hunk.changedOldCount > 0 ? boundedSnippet(hunk.oldLines) : undefined;
  const after = hunk.changedNewCount > 0 ? boundedSnippet(hunk.newLines) : undefined;
  if ((before !== undefined && before.length > MAX_REPORT_TEXT_LENGTH)
    || (after !== undefined && after.length > MAX_REPORT_TEXT_LENGTH)) return undefined;
  return {
    title: `Changed lines in ${pathLabel}`,
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
    evidence,
  };
}

function parseHunkHeader(line: string): {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
} | undefined {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) return undefined;
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
  };
}

function hasIncompleteHunks(lines: string[]): boolean {
  let expected: { oldCount: number; newCount: number } | undefined;
  let oldCount = 0;
  let newCount = 0;
  let changed = false;
  const incomplete = () => expected !== undefined && (oldCount !== expected.oldCount || newCount !== expected.newCount || !changed);
  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (incomplete()) return true;
      expected = parseHunkHeader(line);
      if (!expected) return true;
      oldCount = 0;
      newCount = 0;
      changed = false;
    } else if (expected && line !== '' && !line.startsWith('\\')) {
      if (line.startsWith('-') || line.startsWith('+')) changed = true;
      if (line.startsWith(' ') || line.startsWith('-')) oldCount += 1;
      if (line.startsWith(' ') || line.startsWith('+')) newCount += 1;
      if (!/^[ +\-]/.test(line) || oldCount > expected.oldCount || newCount > expected.newCount) return true;
    }
  }
  return incomplete();
}

function parseUnifiedDiff(
  diff: string,
  owner: string,
  repository: string,
  pullRequestNumber: number,
): ParsedDiff {
  if (typeof diff !== 'string' || diff.trim() === '') throw new Error('PR diff is missing');
  if (Buffer.byteLength(diff, 'utf8') > MAX_DIFF_BYTES) throw new Error('PR diff exceeds the report size limit');

  const changes: ReviewChange[] = [];
  let totalHunks = 0;
  let oldPath: string | undefined;
  let newPath: string | undefined;
  let filePath: string | undefined;
  let hunk: HunkCapture | undefined;

  const finishCurrentHunk = () => {
    const change = finishHunk(hunk, owner, repository, pullRequestNumber);
    if (change) {
      totalHunks += 1;
      if (changes.length < MAX_CHANGES) changes.push(change);
    }
    hunk = undefined;
  };

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      finishCurrentHunk();
      oldPath = undefined;
      newPath = undefined;
      filePath = undefined;
      continue;
    }
    if (!hunk && line.startsWith('--- ')) {
      oldPath = decodeGitPath(line.slice(4), 'a/');
      filePath = newPath ?? oldPath;
      continue;
    }
    if (!hunk && line.startsWith('+++ ')) {
      newPath = decodeGitPath(line.slice(4), 'b/');
      filePath = newPath ?? oldPath;
      continue;
    }
    const header = parseHunkHeader(line);
    if (header) {
      finishCurrentHunk();
      if (!filePath) continue;
      hunk = {
        oldPath,
        newPath,
        path: filePath,
        oldLines: [],
        newLines: [],
        oldLine: header.oldStart,
        newLine: header.newStart,
        expectedOld: header.oldCount,
        expectedNew: header.newCount,
        consumedOld: 0,
        consumedNew: 0,
        changedOldCount: 0,
        changedNewCount: 0,
      };
      if (header.oldCount === 0 && header.newCount === 0) finishCurrentHunk();
      continue;
    }
    if (!hunk || line.startsWith('\\')) continue;
    // A standard unified diff often ends with a newline, yielding one empty split item.
    if (line === '') continue;
    if (line.startsWith('+')) {
      if (hunk.newLines.length < MAX_CHANGED_LINES_PER_SIDE) {
        hunk.newLines.push({ line: Math.max(1, hunk.newLine), text: line.slice(1) });
      }
      hunk.changedNewCount += 1;
      hunk.consumedNew += 1;
      hunk.newLine += 1;
    } else if (line.startsWith('-')) {
      if (hunk.oldLines.length < MAX_CHANGED_LINES_PER_SIDE) {
        hunk.oldLines.push({ line: Math.max(1, hunk.oldLine), text: line.slice(1) });
      }
      hunk.changedOldCount += 1;
      hunk.consumedOld += 1;
      hunk.oldLine += 1;
    } else if (line.startsWith(' ')) {
      hunk.consumedOld += 1;
      hunk.consumedNew += 1;
      hunk.oldLine += 1;
      hunk.newLine += 1;
    } else {
      finishCurrentHunk();
      continue;
    }
    if (hunk && hunk.consumedOld === hunk.expectedOld && hunk.consumedNew === hunk.expectedNew) {
      finishCurrentHunk();
    }
  }
  finishCurrentHunk();
  let totalMetadata = 0;
  let unrepresentedSections = 0;
  const unrepresentedPaths: string[] = [];
  const normalized = diff.replace(/\r\n/g, '\n');
  const blocks = normalized.split(/(?=^diff --git )/m);
  for (const [index, block] of blocks.entries()) {
    if (!block.trim()) continue;
    // A later section header proves the preceding section ended, even if the
    // final section of the entire diff is truncated.
    const complete = index < blocks.length - 1 || normalized.endsWith('\n');
    const change = complete ? nonTextualChange(block, owner, repository, pullRequestNumber) : undefined;
    if (change) {
      totalMetadata += 1;
      if (changes.length < MAX_CHANGES) changes.push(change);
      continue;
    }
    const lines = block.split('\n');
    const hunkIndex = lines.findIndex((line) => line.startsWith('@@ '));
    const header = lines.slice(1, hunkIndex < 0 ? undefined : hunkIndex);
    const oldMarker = header.find((line) => line.startsWith('--- '));
    const newMarker = header.find((line) => line.startsWith('+++ '));
    const validPaths = oldMarker !== undefined && newMarker !== undefined
      && (oldMarker === '--- /dev/null' || decodeGitPath(oldMarker.slice(4), 'a/') !== undefined)
      && (newMarker === '+++ /dev/null' || decodeGitPath(newMarker.slice(4), 'b/') !== undefined)
      && !(oldMarker === '--- /dev/null' && newMarker === '+++ /dev/null');
    // Only ordinary text headers are fully accounted for by the hunk parser.
    // Everything else (including unsupported or incomplete sections) requires
    // inspection of the original diff; do not guess its metadata semantics.
    const ordinaryText = block.startsWith('diff --git ') && hunkIndex >= 0 && validPaths
      && header.every((line) => line === '' || /^index [0-9a-f]+\.\.[0-9a-f]+(?: 100(?:644|755))?$/.test(line)
        || line.startsWith('--- ') || line.startsWith('+++ '))
      && lines.slice(hunkIndex).every((line) => line === '' || /^[ +\-\\]/.test(line) || line.startsWith('@@ '));
    if (!ordinaryText || hasIncompleteHunks(lines.slice(hunkIndex))) {
      unrepresentedSections += 1;
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[0] ?? '');
      const paths = match && isSafeRepositoryPath(match[1]) && isSafeRepositoryPath(match[2])
        && !match[1].includes(' b/') && !match[2].includes(' b/') && !match[1].includes('"') && !match[2].includes('"')
        ? [...new Set([match[1], match[2]])].join(' → ') : 'unknown';
      unrepresentedPaths.push(paths);
    }
  }
  return { changes, totalHunks, totalMetadata, unrepresentedSections, unrepresentedPaths };
}

/** Extract the first actual changed hunk; never infer a missing before/after side. */
export function extractReviewDiffChange(
  diff: string,
  owner: string,
  repository: string,
  pullRequestNumber: number,
): ReviewChange {
  const parsed = parseUnifiedDiff(diff, owner, repository, pullRequestNumber);
  if (parsed.changes[0]) return parsed.changes[0];
  throw new Error('PR diff has no valid changed hunk evidence');
}

export interface BuildReviewReportInput {
  owner: string;
  repository: string;
  pullRequestNumber: number;
  title: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  diff: string;
  draft: ReviewDraft;
  testResult: ReviewTestRunnerResult;
  generatedAt?: string;
}

function boundedReportText(value: string, maxLength = MAX_REPORT_TEXT_LENGTH): string {
  const sanitized = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '\uFFFD').trim();
  const characters = Array.from(sanitized);
  if (characters.length <= maxLength && sanitized.length <= maxLength) return sanitized;
  let bounded = `${characters.slice(0, Math.max(0, maxLength - 1)).join('')}…`;
  while (bounded.length > maxLength) bounded = `${Array.from(bounded).slice(0, -2).join('')}…`;
  return bounded;
}

function findingConfidence(confidence?: 'confirmed' | 'uncertain'): ReviewFinding['confidence'] {
  return confidence ?? 'not_recorded';
}

function buildReviewFindings(draft: ReviewDraft): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const push = (finding: ReviewFinding) => {
    if (findings.length < MAX_REVIEW_FINDINGS) findings.push(finding);
  };

  for (const comment of draft.comments) {
    push({
      source: 'inline_comment',
      status: comment.kind === 'proposal' ? 'proposal' : 'finding',
      severity: comment.severity,
      confidence: findingConfidence(comment.verification?.confidence),
      ...(comment.verification?.uncertaintyReason !== undefined ? { uncertaintyReason: comment.verification.uncertaintyReason } : {}),
      body: boundedReportText(comment.body),
      path: comment.path,
      line: comment.line,
      side: comment.side,
    });
  }
  for (const reply of draft.replies) {
    push({
      source: 'thread_reply',
      status: 'reply',
      severity: reply.severity,
      confidence: findingConfidence(reply.verification?.confidence),
      ...(reply.verification?.uncertaintyReason !== undefined ? { uncertaintyReason: reply.verification.uncertaintyReason } : {}),
      body: boundedReportText(reply.body),
      threadId: reply.commentId,
    });
  }
  for (const existing of draft.existingFindings ?? []) {
    push({
      source: 'existing_thread',
      status: existing.status,
      severity: existing.severity ?? 'unknown',
      confidence: existing.status === 'uncertain' ? 'uncertain' : 'not_recorded',
      body: boundedReportText(existing.body),
      threadId: existing.commentId,
    });
  }
  return findings;
}

function reviewEvidenceForDraftComment(input: BuildReviewReportInput, comment: ReviewDraft['comments'][number]): ReviewEvidence {
  return {
    kind: 'analysis',
    label: '독립 검증된 리뷰 제안',
    detail: '검증된 ReviewDraft의 인라인 대상(path, line, side)에서 가져왔습니다.',
    path: comment.path,
    startLine: comment.line,
    endLine: comment.line,
    side: comment.side,
    url: `https://github.com/${input.owner}/${input.repository}/pull/${input.pullRequestNumber}/files`,
  };
}

function buildDecisionOptions(input: BuildReviewReportInput): ReviewReport['decisionOptions'] {
  return input.draft.comments
    .filter((comment) => comment.kind === 'proposal' && comment.proposal !== undefined)
    .slice(0, MAX_DECISION_OPTIONS)
    .map((comment, index) => {
      const proposal = comment.proposal;
      if (!proposal) throw new Error('verified proposal is missing its trade-offs');
      return {
        id: `analysis-proposal-${index + 1}`,
        title: boundedReportText(proposal.proposal, 240),
        source: 'analysis_proposal' as const,
        status: 'proposal' as const,
        description: boundedReportText(comment.body),
        benefits: [boundedReportText(proposal.benefit)],
        drawbacks: [boundedReportText(proposal.risk)],
        assumptions: [],
        provenance: [reviewEvidenceForDraftComment(input, comment)],
        convention: boundedReportText(proposal.convention),
        scope: proposal.scope,
      };
    });
}

function stageReason(reason: string | undefined, stage: 'install' | 'test'): string {
  return boundedReportText(reason ?? `격리 ${stage} 단계의 사유가 실행 결과에 기록되지 않았습니다.`);
}

function boundedDiagnostic(value: string): string {
  const marker = '\n[output truncated]';
  const sanitized = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '\uFFFD').trim();
  return sanitized.length <= MAX_REPORT_TEXT_LENGTH ? sanitized : `${sanitized.slice(0, MAX_REPORT_TEXT_LENGTH - marker.length)}${marker}`;
}

function buildTestRunnerResult(result: ReviewTestRunnerResult): ReviewTestRunner {
  const stage = (value: ReviewTestRunnerResult['install'], name: 'install' | 'test') => ({
    status: value.status,
    reason: stageReason(value.reason, name),
    ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }),
    ...(value.output === undefined || !value.output.trim() ? {} : { output: boundedReportText(value.output) }),
    ...(value.stdout === undefined || !value.stdout.trim() ? {} : { stdout: boundedDiagnostic(value.stdout) }),
    ...(value.stderr === undefined || !value.stderr.trim() ? {} : { stderr: boundedDiagnostic(value.stderr) }),
  });
  return {
    ...(result.nodeVersion === undefined ? {} : { runtime: boundedReportText(result.nodeVersion, 240) }),
    ...(result.testCommand === undefined ? {} : { selectedCommand: boundedReportText(result.testCommand, 240) }),
    status: result.status,
    reason: boundedReportText(result.reason),
    install: stage(result.install, 'install'),
    test: stage(result.test, 'test'),
  };
}

/** Build a conservative, non-LLM report from pinned PR facts and verified outputs. */
export function buildReviewReport(input: BuildReviewReportInput): ReviewReport {
  const parsedDiff = parseUnifiedDiff(
    input.diff,
    input.owner,
    input.repository,
    input.pullRequestNumber,
  );
  const changes = parsedDiff.changes;
  const reviewSummaryPrefix = '검증된 리뷰 요약 (승인 판정이 아닙니다): ';
  const draftSummary = boundedReportText(input.draft.summary, MAX_REPORT_TEXT_LENGTH - reviewSummaryPrefix.length);
  const conclusion = `${reviewSummaryPrefix}${draftSummary}`;
  const paths = [...new Set(changes.flatMap((change) => change.evidence.map((evidence) => evidence.path).filter((path): path is string => path !== undefined)))];
  const visiblePaths = paths.slice(0, 16).join(', ');
  const omittedPathCount = Math.max(0, paths.length - 16);
  const omittedHunkCount = Math.max(0, parsedDiff.totalHunks - changes.filter((change) => change.nonTextual === undefined).length);
  const changeHunksOmitted = omittedHunkCount;
  const omittedMetadataCount = Math.max(0, parsedDiff.totalMetadata - changes.filter((change) => change.nonTextual !== undefined).length);
  const incompletePaths = parsedDiff.unrepresentedPaths;
  let visibleIncomplete = '';
  let visibleIncompleteCount = 0;
  for (const path of incompletePaths) {
    const next = visibleIncomplete ? `${visibleIncomplete}; ${path}` : path;
    if (next.length > 900) break;
    visibleIncomplete = next;
    visibleIncompleteCount += 1;
  }
  const coverageWarning = parsedDiff.unrepresentedSections > 0
    ? `${parsedDiff.unrepresentedSections}개 diff 섹션의 불완전한 hunk, 메타데이터 또는 지원되지 않는 내용은 보고서에 완전히 표시되지 않았을 수 있습니다. 경로: ${visibleIncomplete}${incompletePaths.length > visibleIncompleteCount ? `; 외 ${incompletePaths.length - visibleIncompleteCount}개 섹션 경로 생략` : ''}. 원본 diff를 확인하세요. `
    : '';
  const overview = coverageWarning + (omittedMetadataCount > 0 ? `보고서 한도로 ${omittedMetadataCount}개 메타데이터는 생략했습니다. ` : '') + (changes.length === 0
    ? '가져온 PR diff에서 텍스트 변경 hunk를 확인하지 못했습니다. 변경 내용을 추정하지 않았습니다.'
    : `가져온 PR diff에서 ${parsedDiff.totalHunks}개 변경 hunk와 ${parsedDiff.totalMetadata}개 비텍스트 메타데이터를 확인했습니다. 경로: ${visiblePaths}${omittedPathCount > 0 ? ` 외 ${omittedPathCount}개 경로` : ''}.${omittedHunkCount > 0 ? ` 보고서 한도 ${MAX_CHANGES}개로 ${omittedHunkCount}개 hunk는 생략했습니다.` : ''}`);
  const testRunner = buildTestRunnerResult(input.testResult);
  const reviewFindingCount = input.draft.comments.length + input.draft.replies.length + (input.draft.existingFindings?.length ?? 0);
  const reviewFindingsOmitted = Math.max(0, reviewFindingCount - MAX_REVIEW_FINDINGS);
  const decisionOptions = buildDecisionOptions(input);
  const proposalCount = input.draft.comments.filter((comment) => comment.kind === 'proposal').length;
  const decisionOptionsOmitted = Math.max(0, proposalCount - decisionOptions.length);
  const impactProven = changes.length === 0
    ? []
    : [`가져온 PR diff에 ${parsedDiff.totalHunks}개 변경 hunk와 ${parsedDiff.totalMetadata}개 비텍스트 메타데이터가 있으며, 표시된 경로는 ${visiblePaths}${omittedPathCount > 0 ? ` 외 ${omittedPathCount}개` : ''}입니다.`];
  const findings = buildReviewFindings(input.draft);
  const actionable = findings.filter((finding) => finding.status === 'finding' || finding.status === 'reply'
    || finding.status === 'still_applies' || finding.status === 'uncertain');
  const location = (finding: ReviewFinding) => finding.path
    ? `${finding.path}:${finding.line} (${finding.side})`
    : `스레드 ${finding.threadId}`;
  const requiredDecisions = [
    ...actionable.slice(0, 8).map((finding) => boundedReportText(`${location(finding)} · ${finding.severity} / ${finding.confidence}: ${finding.body} — 사람 리뷰어가 조치 또는 수용 여부를 판단합니다.`)),
    ...decisionOptions.slice(0, 8).map((option) => boundedReportText(`제안 검토 (${option.scope}): ${option.title} — 제시된 이점과 위험을 비교합니다.`)),
  ];
  if (requiredDecisions.length === 0) requiredDecisions.push('검증된 finding이나 제안이 없어도 변경 범위와 검증 결과를 확인한 후 사람이 결정합니다.');
  const humanChecklist: ReviewReport['humanChecklist'] = actionable.slice(0, 12).map((finding, index) => ({
    id: `finding-${index + 1}`,
    question: boundedReportText(`${location(finding)}: ${finding.body}${finding.uncertaintyReason ? ` 확인 필요: ${finding.uncertaintyReason}` : ''} — 근거와 조치 여부를 확인했나요?`),
    rationale: `검증 상태: ${finding.confidence}; 심각도: ${finding.severity}; 출처: ${finding.source}.`,
  }));
  humanChecklist.push({ id: 'proposal-tradeoffs', question: decisionOptions.length
    ? boundedReportText(`검증된 제안의 이점, 위험, 관례와 범위를 비교했나요? ${decisionOptions.slice(0, 3).map((option) => option.title).join('; ')}`)
    : '검증된 제안은 없습니다. 별도 설계 판단이 필요한지 확인했나요?' });
  humanChecklist.push({ id: 'test-coverage', question: boundedReportText(`격리 테스트 결과 ${testRunner.status}: ${testRunner.reason} 이 결과와 미실행 범위를 확인했나요?`) });
  humanChecklist.push({ id: 'impact', question: '변경 경로의 호출자, 계약, 데이터, 배포 및 롤백 영향을 주변 코드와 운영 근거로 확인했나요?' });
  if (actionable.length > 12 || decisionOptions.length > 3) humanChecklist.push({ id: 'remaining', question: '목록에 요약되지 않은 나머지 finding과 제안도 검토했나요?' });

  return {
    schemaVersion: 1,
    executiveSummary: {
      conclusion,
      requiredDecisions,
      overallRisk: {
        level: 'unknown',
        title: '운영 영향 미확정',
        rationale: 'PR diff와 검증된 리뷰 내용만으로는 런타임, 배포, 운영 데이터에 미치는 영향을 확정할 수 없습니다.',
        mitigations: ['주변 코드와 배포·운영 맥락을 확인한 뒤 사람이 위험도를 판단합니다.'],
      },
    },
    metadata: {
      owner: input.owner,
      repository: input.repository,
      pullRequestNumber: input.pullRequestNumber,
      title: input.title,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
      headRef: input.headRef,
      headSha: input.headSha,
      generatedAt: input.generatedAt ?? new Date().toISOString(),
    },
    changeSummary: { overview: boundedReportText(`${overview}\n검증된 리뷰 요약: ${boundedReportText(input.draft.summary, 1000)}`), changes },
    ...(changeHunksOmitted > 0 ? { changeHunksOmitted } : {}),
    flowGraph: {
      status: 'unavailable',
      nodes: [],
      edges: [],
      note: '정적 생성기는 코드 실행 흐름을 독립적으로 추적한 근거를 받지 않았으므로 그래프를 만들지 않았습니다.',
    },
    decisionOptions,
    impactScope: {
      proven: impactProven,
      inferred: [],
      unknown: [
        '호출자와 API·이벤트 계약, 데이터 무결성 및 형제 시스템 영향은 확인되지 않았습니다.',
        '배포 범위, 호환성, 롤백 가능성, 모니터링 및 실제 발생 빈도는 확인되지 않았습니다.',
      ],
    },
    risks: [
      { level: 'unknown', title: '테스트 및 검증 범위', rationale: boundedReportText(`격리 테스트 ${testRunner.status}: ${testRunner.reason}`), mitigations: ['실행 결과와 미검증 경로를 확인합니다.'] },
      { level: 'unknown', title: '호환성 및 데이터 영향', rationale: '변경된 경로는 diff에서 확인되지만 호출자, 계약 및 운영 데이터 영향은 이 입력만으로 확정할 수 없습니다.', mitigations: ['주변 호출자와 데이터 계약을 확인합니다.'] },
      { level: 'unknown', title: '배포 범위 및 되돌리기', rationale: '배포 경로, 영향 범위, 롤백 절차 및 모니터링 근거가 제공되지 않았습니다.', mitigations: ['배포 및 롤백 계획과 관측 지표를 확인합니다.'] },
    ],
    checks: [{
      name: 'Isolated PR test runner',
      status: testRunner.status,
      details: testRunner.reason,
      evidence: [{
        kind: 'test',
        label: '격리 테스트 러너 전체 결과',
        detail: `상태: ${testRunner.status}; runtime: ${testRunner.runtime ?? 'not recorded'}; selected command: ${testRunner.selectedCommand ?? 'not selected'}.`,
      }],
    }],
    reviewFindings: buildReviewFindings(input.draft),
    ...(reviewFindingsOmitted > 0 ? { reviewFindingsOmitted } : {}),
    ...(decisionOptionsOmitted > 0 ? { decisionOptionsOmitted } : {}),
    testRunner,
    slack: {
      status: 'unavailable',
      items: [],
      note: 'Slack provider is unavailable for this report; no Slack messages were collected.',
    },
    humanChecklist,
  };
}
