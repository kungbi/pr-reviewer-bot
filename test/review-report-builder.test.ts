import { buildReviewReport, extractReviewDiffChange } from '../src/review/review-report-builder';
import type { BuildReviewReportInput } from '../src/review/review-report-builder';
import { renderReviewReportHtml } from '../src/review/review-report-renderer';
import { normalizeReviewReport } from '../src/review/review-report';

const multiHunkDiff = [
  'diff --git a/src/payments/controller.ts b/src/payments/controller.ts',
  'index 1111111..2222222 100644',
  '--- a/src/payments/controller.ts',
  '+++ b/src/payments/controller.ts',
  '@@ -1,2 +1,3 @@',
  ' const id = request.id;',
  '-save(id);',
  '+validate(id);',
  '+save(id);',
  '@@ -10 +11 @@',
  '-return false;',
  '+return true;',
  'diff --git a/src/payments/new.ts b/src/payments/new.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/payments/new.ts',
  '@@ -0,0 +1,2 @@',
  '+export const added = true;',
  '+export const another = true;',
  'diff --git a/src/payments/old.ts b/src/payments/old.ts',
  'deleted file mode 100644',
  '--- a/src/payments/old.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-export const removed = true;',
  '-export const anotherRemoved = true;',
  '',
].join('\n');

function reportInput(overrides: Partial<BuildReviewReportInput> = {}): BuildReviewReportInput {
  return {
    owner: 'acme',
    repository: 'payments',
    pullRequestNumber: 17,
    title: '결제 경로 검증',
    baseRef: 'main',
    baseSha: 'a'.repeat(40),
    headRef: 'feat/validation',
    headSha: 'b'.repeat(40),
    diff: multiHunkDiff,
    draft: {
      summary: '빈 식별자 검증을 추가하고 기존 스레드 상태를 재평가했습니다.',
      comments: [
        {
          path: 'src/payments/controller.ts', line: 2, side: 'RIGHT', severity: 'important', kind: 'finding',
          body: '빈 식별자가 거부되지 않습니다.', verification: { confidence: 'confirmed' },
        },
        {
          path: 'src/payments/controller.ts', line: 3, side: 'RIGHT', severity: 'minor', kind: 'proposal',
          body: '간결한 구현을 제안합니다.',
          proposal: {
            proposal: '검증 함수를 재사용합니다.', benefit: '중복 분기를 줄입니다.', risk: '호출 계약이 달라질 수 있습니다.',
            convention: '인접 컨트롤러도 공유 검증을 씁니다.', scope: 'current_pr',
          },
          verification: { confidence: 'uncertain', uncertaintyReason: '다른 호출부의 사용 여부는 확인하지 못했습니다.' },
        },
      ],
      replies: [{
        commentId: 41, severity: 'blocker', body: '재현 조건을 추가 확인해야 합니다.',
        verification: { confidence: 'uncertain', uncertaintyReason: '운영 설정은 확인하지 못했습니다.' },
      }],
      existingFindings: [
        { commentId: 41, status: 'still_applies', severity: 'important', body: '기존 지적은 현재 코드에도 남아 있습니다.' },
        { commentId: 42, status: 'fixed_in_code', severity: null, body: '현재 HEAD에서 수정된 것으로 평가했습니다.' },
        { commentId: 43, status: 'not_actionable', severity: null, body: '현재 변경 범위에는 적용되지 않습니다.' },
        { commentId: 44, status: 'uncertain', severity: null, body: '기존 동작과의 관계를 확인하지 못했습니다.' },
      ],
    },
    testResult: {
      status: 'blocked',
      reason: 'Docker is unavailable; no host command ran.',
      nodeVersion: '22.2.0',
      testCommand: 'npm run test:unit',
      install: { status: 'blocked', reason: 'Docker daemon is unavailable.' },
      test: { status: 'not_run', reason: 'Installation did not pass.' },
    },
    generatedAt: '2026-10-21T02:00:00.000Z',
    ...overrides,
  };
}

describe('uncertainty reasons in reports', () => {
  it('preserves inline and reply reasons through normalization and escapes them in HTML', () => {
    const input = reportInput();
    const inlineReason = 'Missing <contract> & caller evidence; inspect "config".';
    const replyReason = 'Missing runtime evidence; check deployment settings.';
    input.draft.comments[1].verification!.uncertaintyReason = inlineReason;
    input.draft.replies[0].verification!.uncertaintyReason = replyReason;
    const report = normalizeReviewReport(buildReviewReport(input));
    expect(report.reviewFindings![1]).toMatchObject({ uncertaintyReason: inlineReason });
    expect(report.reviewFindings![2]).toMatchObject({ uncertaintyReason: replyReason });
    expect(report.reviewFindings![0]).not.toHaveProperty('uncertaintyReason');
    const html = renderReviewReportHtml(report);
    expect(html).toContain('Missing &lt;contract&gt; &amp; caller evidence; inspect &quot;config&quot;.');
    expect(html).toContain(replyReason);
    expect(html).toContain('확신하지 못한 이유');
  });

  it('rejects invalid uncertainty reason values', () => {
    const report = buildReviewReport(reportInput()) as unknown as Record<string, any>;
    report.reviewFindings[1].uncertaintyReason = '<script>\u0000</script>';
    expect(() => normalizeReviewReport(report)).toThrow(/uncertaintyReason/);
  });
});

describe('extractReviewDiffChange', () => {
  it.each([
    ['binary', 'diff --git a/img/<logo>.png b/img/<logo>.png\nindex 1111111..2222222 100644\nBinary files a/img/<logo>.png and b/img/<logo>.png differ\n'],
    ['binary-add', 'diff --git a/img/new.png b/img/new.png\nnew file mode 100644\nindex 0000000..1234567\nBinary files /dev/null and b/img/new.png differ\n'],
    ['binary-delete', 'diff --git a/img/old.png b/img/old.png\ndeleted file mode 100644\nindex 1234567..0000000\nBinary files a/img/old.png and /dev/null differ\n'],
    ['mode', 'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n'],
    ['rename', 'diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n'],
  ])('reports grounded %s metadata without inventing content', (kind, diff) => {
    const change = extractReviewDiffChange(diff, 'acme', 'payments', 17);
    expect(change).toMatchObject({ nonTextual: kind.startsWith('binary') ? 'binary' : kind, evidence: [expect.objectContaining({ kind: 'diff' })] });
    expect(change.before).toBeUndefined();
    expect(change.after).toBeUndefined();
    const report = normalizeReviewReport(buildReviewReport(reportInput({ diff })));
    const html = renderReviewReportHtml(report);
    expect(html).toContain('텍스트 내용은 확인할 수 없습니다');
    expect(html).not.toContain('이 hunk에 변경 전 줄이 없습니다');
    if (kind === 'binary') expect(html).toContain('&lt;logo&gt;');
  });

  it.each([
    'diff --git a/a b/a\nold mode 100644\n',
    'diff --git a/a b/b\nrename from a\n',
    'diff --git a/a b/a\nBinary files a/a and b/other differ\n',
    'diff --git a/a b/a\nindex 1234567..7654321 100644\n',
    'diff --git a/a b/a\nold mode 100644\nnew mode 100755',
    'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n',
  ])('rejects incomplete or ungrounded non-hunk input', (diff) => {
    expect(() => extractReviewDiffChange(diff, 'acme', 'payments', 17)).toThrow();
  });

  it('rejects non-textual records without diff path evidence or with invented snippets', () => {
    const diff = 'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n';
    const report = buildReviewReport(reportInput({ diff }));
    report.changeSummary.changes[0].before = 'invented';
    expect(() => normalizeReviewReport(report)).toThrow();
    delete report.changeSummary.changes[0].before;
    report.changeSummary.changes[0].evidence = [{ kind: 'analysis', label: 'claim', detail: 'no diff' }];
    expect(() => normalizeReviewReport(report)).toThrow();
  });

  it('extracts before/after evidence from a standard unified diff hunk', () => {
    const diff = [
      'diff --git a/src/payments/controller.ts b/src/payments/controller.ts',
      'index 1111111..2222222 100644',
      '--- a/src/payments/controller.ts',
      '+++ b/src/payments/controller.ts',
      '@@ -10,2 +10,3 @@',
      ' const id = request.id;',
      '-save(id);',
      '+if (!id) throw new Error("missing id");',
      '+save(id);',
      '',
    ].join('\n');

    const change = extractReviewDiffChange(diff, 'acme', 'payments', 17);

    expect(change.title).toBe('Changed lines in src/payments/controller.ts');
    expect(change.before).toBe('save(id);');
    expect(change.after).toBe('if (!id) throw new Error("missing id");\nsave(id);');
    expect(change.evidence[0]).toMatchObject({
      kind: 'diff',
      path: 'src/payments/controller.ts',
      startLine: 11,
      endLine: 12,
      url: 'https://github.com/acme/payments/pull/17/files',
    });
  });
});

describe('buildReviewReport', () => {
  it('retains separate diagnostics through normalization and escaped HTML', () => {
    const input = reportInput();
    input.testResult.test = { status: 'failed', exitCode: 2, stdout: 'x'.repeat(9000), stderr: 'FAIL <assertion> & details' } as any;
    const report = normalizeReviewReport(buildReviewReport(input));
    expect((report.testRunner!.test as any).stdout).toContain('[output truncated]');
    expect((report.testRunner!.test as any).stderr).toBe('FAIL <assertion> & details');
    expect(report.testRunner!.test.exitCode).toBe(2);
    const html = renderReviewReportHtml(report);
    expect(html).toContain('FAIL &lt;assertion&gt; &amp; details');
    expect(html).toContain('[output truncated]');
  });

  it('identifies incomplete sections and unknown unsafe paths in escaped HTML', () => {
    const diff = 'diff --git a/src/<broken>.ts b/src/<broken>.ts\n--- a/src/<broken>.ts\n+++ b/src/<broken>.ts\n@@ -1 +1 @@\n-old\n'
      + 'diff --git a/../unsafe b/../unsafe\nGIT binary patch\nliteral 2\n';
    const report = normalizeReviewReport(buildReviewReport(reportInput({ diff })));
    expect(report.changeSummary.overview).toContain('2개 diff 섹션');
    expect(report.changeSummary.overview).toContain('src/<broken>.ts');
    expect(report.changeSummary.overview).toContain('unknown');
    const html = renderReviewReportHtml(report);
    expect(html).toContain('src/&lt;broken&gt;.ts');
    expect(html).not.toContain('../unsafe');
  });

  it('warns when a valid hunk is followed by a truncated hunk in the same section', () => {
    const diff = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n@@ -4 +4 @@\n-incomplete\n';
    const report = normalizeReviewReport(buildReviewReport(reportInput({ diff })));
    expect(report.changeSummary.changes).toHaveLength(1);
    expect(report.changeSummary.overview).toContain('1개 diff 섹션');
    expect(renderReviewReportHtml(report)).toContain('원본 diff를 확인하세요');
  });

  it('preserves bounded runner diagnostics and exit codes in the snapshot and escaped HTML', () => {
    const input = reportInput();
    input.testResult = { status: 'failed', reason: 'test failed', install: { status: 'passed', exitCode: 0, output: 'installed' }, test: { status: 'failed', exitCode: 2, output: 'FAIL <img src=x> & assertion\n' + 'x'.repeat(9000) } };
    const report = normalizeReviewReport(buildReviewReport(input));
    expect(report.testRunner!.install).toMatchObject({ exitCode: 0, output: 'installed' });
    const testStage = report.testRunner!.test as any;
    expect(testStage.exitCode).toBe(2);
    expect(testStage.output.length).toBeLessThanOrEqual(2000);
    expect(testStage.output).toContain('FAIL <img src=x> & assertion');
    const html = renderReviewReportHtml(report);
    expect(html).toContain('FAIL &lt;img src=x&gt; &amp; assertion');
    expect(html).toContain('종료 코드: 2');
    expect(html).not.toContain('<img src=x>');
  });
  it('flags mixed metadata and unsupported sections even when text hunks are present', () => {
    const diff = [
      'diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755',
      'index 1111111..2222222', '--- a/run.sh', '+++ b/run.sh', '@@ -1 +1 @@', '-old', '+new',
      'diff --git a/asset b/asset', 'GIT binary patch', 'literal 3', 'abc', '',
    ].join('\n');
    const report = normalizeReviewReport(buildReviewReport(reportInput({ diff })));
    expect(report.changeSummary.changes.some((change) => change.after === 'new')).toBe(true);
    expect(report.changeSummary.overview).toContain('2개 diff 섹션');
    expect(report.changeSummary.overview).toContain('메타데이터');
    expect(renderReviewReportHtml(report)).toContain('2개 diff 섹션');
  });

  it('reports the exact number of recognized metadata entries omitted by the limit', () => {
    const diff = Array.from({ length: 32 }, (_, i) =>
      `diff --git a/f${i} b/f${i}\nold mode 100644\nnew mode 100755\n`).join('');
    const report = normalizeReviewReport(buildReviewReport(reportInput({ diff })));
    expect(report.changeSummary.changes).toHaveLength(30);
    expect(report.changeSummary.overview).toContain('2개 메타데이터');
  });
  it('turns verified PR evidence into specific human decisions, risks and checks without inventing a flow', () => {
    const report = normalizeReviewReport(buildReviewReport(reportInput()));
    const html = renderReviewReportHtml(report);
    expect(report.changeSummary.overview).toContain(reportInput().draft.summary);
    expect(report.executiveSummary.requiredDecisions.join(' ')).toContain('빈 식별자가 거부되지 않습니다.');
    expect(report.executiveSummary.requiredDecisions.join(' ')).toContain('검증 함수를 재사용합니다.');
    expect(report.humanChecklist.map((item) => item.question).join(' ')).toContain('src/payments/controller.ts:2');
    expect(report.humanChecklist.map((item) => item.question).join(' ')).toContain('운영 설정은 확인하지 못했습니다.');
    expect(report.risks.map((risk) => risk.rationale).join(' ')).toContain('Docker is unavailable');
    expect(report.impactScope.unknown.join(' ')).toContain('호출');
    expect(report.flowGraph.status).toBe('unavailable');
    expect(html).toContain('빈 식별자가 거부되지 않습니다.');
    expect(html).toContain('운영 설정은 확인하지 못했습니다.');
  });

  it('does not claim a finding or test failure for an empty review with passing tests', () => {
    const input = reportInput();
    input.draft = { summary: '문서 변경', comments: [], replies: [], existingFindings: [] };
    input.testResult = { status: 'passed', reason: 'All tests passed.', install: { status: 'passed' }, test: { status: 'passed' } };
    const report = normalizeReviewReport(buildReviewReport(input));
    expect(report.executiveSummary.requiredDecisions.join(' ')).not.toContain('빈 식별자');
    expect(report.risks.map((risk) => risk.rationale).join(' ')).toContain('All tests passed.');
    expect(report.risks.every((risk) => risk.level === 'unknown')).toBe(true);
  });
  it('uses the verified review summary and preserves every diff hunk without inventing missing sides', () => {
    const report = buildReviewReport(reportInput());

    expect(report.executiveSummary.conclusion).toContain('검증된 리뷰 요약');
    expect(report.executiveSummary.conclusion).toContain(reportInput().draft.summary);
    expect(report.executiveSummary.conclusion).toContain('승인 판정이 아닙니다');
    expect(report.executiveSummary.conclusion).not.toContain('GitHub publication is COMMENT-only');
    expect(report.changeSummary.changes).toHaveLength(4);
    expect(report.changeSummary.changes.map((change) => [change.before, change.after])).toEqual([
      ['save(id);', 'validate(id);\nsave(id);'],
      ['return false;', 'return true;'],
      [undefined, 'export const added = true;\nexport const another = true;'],
      ['export const removed = true;\nexport const anotherRemoved = true;', undefined],
    ]);
    expect(report.changeSummary.changes.map((change) => change.evidence[0])).toEqual([
      expect.objectContaining({ path: 'src/payments/controller.ts', side: 'RIGHT', startLine: 2, endLine: 3 }),
      expect.objectContaining({ path: 'src/payments/controller.ts', side: 'RIGHT', startLine: 11, endLine: 11 }),
      expect.objectContaining({ path: 'src/payments/new.ts', side: 'RIGHT', startLine: 1, endLine: 2 }),
      expect.objectContaining({ path: 'src/payments/old.ts', side: 'LEFT', startLine: 1, endLine: 2 }),
    ]);
  });

  it('includes verified comments, replies, and thread assessments with provenance and proposal tradeoffs', () => {
    const report = buildReviewReport(reportInput());
    const extended = report as unknown as {
      reviewFindings: Array<Record<string, unknown>>;
    };

    expect(extended.reviewFindings).toHaveLength(7);
    expect(extended.reviewFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'inline_comment', status: 'finding', severity: 'important', confidence: 'confirmed',
        path: 'src/payments/controller.ts', line: 2, side: 'RIGHT', body: '빈 식별자가 거부되지 않습니다.',
      }),
      expect.objectContaining({
        source: 'thread_reply', status: 'reply', severity: 'blocker', confidence: 'uncertain', threadId: 41,
        body: '재현 조건을 추가 확인해야 합니다.',
      }),
      expect.objectContaining({
        source: 'existing_thread', status: 'fixed_in_code', severity: 'unknown', threadId: 42,
      }),
      expect.objectContaining({
        source: 'existing_thread', status: 'uncertain', confidence: 'uncertain', threadId: 44,
      }),
    ]));
    expect(report.decisionOptions).toHaveLength(1);
    expect(report.decisionOptions[0]).toMatchObject({
      source: 'analysis_proposal', status: 'proposal',
      title: '검증 함수를 재사용합니다.',
      benefits: ['중복 분기를 줄입니다.'],
      drawbacks: ['호출 계약이 달라질 수 있습니다.'],
      assumptions: [],
      convention: '인접 컨트롤러도 공유 검증을 씁니다.',
      scope: 'current_pr',
      provenance: [expect.objectContaining({ kind: 'analysis', path: 'src/payments/controller.ts', startLine: 3, side: 'RIGHT' })],
    });
    expect(report.slack).toMatchObject({ status: 'unavailable', items: [] });
    expect(report.slack.note).toContain('provider');
    expect(report.flowGraph).toMatchObject({ status: 'unavailable', nodes: [], edges: [] });
    expect(report.executiveSummary.overallRisk.level).toBe('unknown');
    expect(report.impactScope.unknown.length).toBeGreaterThan(0);
  });

  it('does not fabricate a review decision option when the verified draft has no proposal', () => {
    const input = reportInput({
      draft: { ...reportInput().draft, comments: reportInput().draft.comments.filter((comment) => comment.kind !== 'proposal') },
    });
    const report = buildReviewReport(input);

    expect(report.decisionOptions).toEqual([]);
  });

  it('keeps long changed hunks within snippet bounds instead of dropping them', () => {
    const longLine = 'x'.repeat(1_000);
    const diff = [
      'diff --git a/src/large.ts b/src/large.ts',
      '--- a/src/large.ts',
      '+++ b/src/large.ts',
      '@@ -1,4 +1,4 @@',
      `-${longLine}`,
      `-${longLine}`,
      `-${longLine}`,
      `-${longLine}`,
      `+${longLine}`,
      `+${longLine}`,
      `+${longLine}`,
      `+${longLine}`,
      '',
    ].join('\n');
    const report = buildReviewReport(reportInput({ diff }));

    expect(report.changeSummary.changes).toHaveLength(1);
    expect(report.changeSummary.changes[0].before?.length).toBeLessThanOrEqual(2_000);
    expect(report.changeSummary.changes[0].after?.length).toBeLessThanOrEqual(2_000);
    expect(report.changeSummary.changes[0].evidence.some((item) => item.detail.includes('문자 한도'))).toBe(true);
  });

  it('records changed hunks omitted by the schema limit', () => {
    const diff = Array.from({ length: 31 }, (_, index) => [
      `diff --git a/src/hunk-${index}.ts b/src/hunk-${index}.ts`,
      `--- a/src/hunk-${index}.ts`,
      `+++ b/src/hunk-${index}.ts`,
      `@@ -${index + 1} +${index + 1} @@`,
      `-before ${index}`,
      `+after ${index}`,
    ].join('\n')).join('\n');
    const report = buildReviewReport(reportInput({ diff }));
    const extended = report as unknown as { changeHunksOmitted: number };

    expect(report.changeSummary.changes).toHaveLength(30);
    expect(extended.changeHunksOmitted).toBe(1);
  });

  it('records when verified findings exceed the bounded report list', () => {
    const draft = reportInput().draft;
    const comments = Array.from({ length: 121 }, (_, index) => ({
      path: 'src/payments/controller.ts', line: index + 1, side: 'RIGHT' as const,
      severity: 'minor' as const, kind: 'finding' as const, body: `검증 finding ${index + 1}`,
      verification: { confidence: 'confirmed' as const },
    }));
    const report = buildReviewReport(reportInput({ draft: { ...draft, comments, replies: [], existingFindings: [] } }));
    const extended = report as unknown as { reviewFindings: unknown[]; reviewFindingsOmitted: number };

    expect(extended.reviewFindings).toHaveLength(120);
    expect(extended.reviewFindingsOmitted).toBe(1);
  });

  it('records proposal trade-offs omitted by the schema bound', () => {
    const proposalComments = Array.from({ length: 31 }, (_, index) => ({
      path: 'src/payments/controller.ts', line: index + 1, side: 'RIGHT' as const,
      severity: 'minor' as const, kind: 'proposal' as const, body: `제안 ${index + 1}`,
      proposal: {
        proposal: `검증 제안 ${index + 1}`, benefit: '중복을 줄입니다.', risk: '호출 계약을 살펴야 합니다.',
        convention: '인접 코드에 유사한 경로가 있습니다.', scope: 'follow_up' as const,
      },
      verification: { confidence: 'confirmed' as const },
    }));
    const report = buildReviewReport(reportInput({
      draft: { ...reportInput().draft, comments: proposalComments, replies: [], existingFindings: [] },
    }));
    const extended = report as unknown as { decisionOptionsOmitted: number };

    expect(report.decisionOptions).toHaveLength(30);
    expect(extended.decisionOptionsOmitted).toBe(1);
  });

  it('records isolated runner runtime, command, all stage reasons, and overall status exactly', () => {
    const report = buildReviewReport(reportInput());
    const extended = report as unknown as {
      testRunner: {
        runtime?: string;
        selectedCommand?: string;
        status: string;
        reason: string;
        install: { status: string; reason: string };
        test: { status: string; reason: string };
      };
    };

    expect(extended.testRunner).toEqual({
      runtime: '22.2.0',
      selectedCommand: 'npm run test:unit',
      status: 'blocked',
      reason: 'Docker is unavailable; no host command ran.',
      install: { status: 'blocked', reason: 'Docker daemon is unavailable.' },
      test: { status: 'not_run', reason: 'Installation did not pass.' },
    });
  });

  it('bounds long draft summaries to the report schema without changing their review-only framing', () => {
    const input = reportInput({ draft: { ...reportInput().draft, summary: '요약'.repeat(6_000) } });
    const report = buildReviewReport(input);

    expect(report.executiveSummary.conclusion.length).toBeLessThanOrEqual(2_000);
    expect(report.executiveSummary.conclusion).toContain('검증된 리뷰 요약');
    expect(report.executiveSummary.conclusion).toContain('승인 판정이 아닙니다');
  });
});
