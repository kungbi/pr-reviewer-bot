import { normalizeReviewReport } from '../src/review/review-report';
import type { ReviewEvidence } from '../src/types/review-report.types';

const makeReport = (): Record<string, any> => ({
  schemaVersion: 1,
  executiveSummary: {
    conclusion: '요청 검증 경로를 좁혀 입력 오류를 저장 전에 차단합니다.',
    requiredDecisions: ['기존 호출자 계약을 확인합니다.'],
    overallRisk: {
      level: 'medium',
      title: '호출자 입력 불일치',
      rationale: '기존 호출자가 빈 값을 보낼 수 있습니다.',
      mitigations: ['호출자 목록과 API 계약을 확인합니다.'],
    },
  },
  metadata: {
    owner: 'acme',
    repository: 'payments',
    pullRequestNumber: 17,
    title: '결제 경로 개선',
    baseRef: 'main',
    baseSha: 'a'.repeat(40),
    headRef: 'feat/reconcile',
    headSha: 'b'.repeat(40),
    generatedAt: '2026-10-21T02:00:00.000Z',
  },
  changeSummary: {
    overview: '요청 검증에서 저장까지의 흐름을 요약합니다.',
    changes: [{
      title: '요청 입력 검증 추가',
      before: '빈 식별자가 저장 계층까지 전달될 수 있었습니다.',
      after: '빈 식별자를 컨트롤러에서 거부합니다.',
      evidence: [{
        kind: 'diff',
        label: 'PR diff',
        detail: '요청 필드 검증 변경',
        path: 'src/payments/controller.ts',
        startLine: 10,
        endLine: 14,
        url: 'https://github.com/acme/payments/pull/17/files',
      }],
    }],
  },
  flowGraph: {
    status: 'available',
    nodes: [
      {
        id: 'request',
        label: '요청 검증',
        evidence: [{
          kind: 'code', label: '컨트롤러 검사', detail: '빈 값 분기 확인',
          path: 'src/payments/controller.ts', startLine: 10, endLine: 14,
        }],
      },
      {
        id: 'store',
        label: '저장소 갱신',
        evidence: [{
          kind: 'code', label: '저장 호출', detail: '검증된 요청 전달',
          path: 'src/payments/store.ts', startLine: 31, endLine: 35,
        }],
      },
    ],
    edges: [{
      from: 'request',
      to: 'store',
      label: '통과한 요청 전달',
      evidence: [{
        kind: 'code', label: '호출 연결', detail: '컨트롤러에서 저장소 호출',
        path: 'src/payments/controller.ts', startLine: 15, endLine: 15,
      }],
    }],
  },
  decisionOptions: [{
    id: 'current',
    title: '현재 변경 범위 유지',
    source: 'analysis_proposal',
    status: 'proposal',
    description: '검증 변경을 이번 PR에 한정합니다.',
    benefits: ['수정 범위가 작습니다.'],
    drawbacks: ['하위 호출자의 입력 계약은 별도 확인이 필요합니다.'],
    assumptions: ['상위 API가 빈 값을 허용하지 않습니다.'],
    provenance: [{
      kind: 'code', label: '호출자 계약', detail: 'API 타입과 검증 위치 비교',
      path: 'src/payments/controller.ts', startLine: 10,
    }],
  }],
  impactScope: {
    proven: ['컨트롤러 입력 검증이 추가됩니다.'],
    inferred: ['유효하지 않은 값의 저장 시도가 줄어들 수 있습니다.'],
    unknown: ['운영 데이터에서 빈 식별자가 발생한 빈도는 알 수 없습니다.'],
  },
  risks: [{
    level: 'medium',
    title: '기존 호출자의 입력 불일치',
    rationale: '다른 호출자가 빈 값을 보내면 응답 동작이 달라질 수 있습니다.',
    mitigations: ['호출자 목록과 API 계약을 확인합니다.'],
  }],
  checks: [
    { name: 'TypeScript build', status: 'passed', details: '컴파일 성공', evidence: [{ kind: 'ci', label: '빌드 로그', detail: 'tsc exit 0' }] },
    { name: 'Integration tests', status: 'failed', details: '한 테스트가 실패했습니다.', evidence: [{ kind: 'test', label: '테스트 실행', detail: '재현 확인' }] },
    { name: 'Deployment check', status: 'blocked', details: '배포 환경에 접근할 수 없습니다.', evidence: [] },
    { name: 'Load tests', status: 'not_run', details: '이번 검토에서 실행하지 않았습니다.', evidence: [] },
  ],
  slack: {
    status: 'available',
    items: [{
      summary: '호출자 계약을 확인해 달라는 논의가 있습니다.',
      permalink: 'https://acme.slack.com/archives/C123/p1729500000000000',
      timestamp: '2026-10-21T01:00:00.000Z',
    }],
  },
  humanChecklist: [{
    id: 'runtime-contract',
    question: '운영 호출자가 동일한 입력 계약을 따르는지 확인했나요?',
    rationale: '저장소의 코드만으로 배포 설정과 실제 호출 빈도를 확인할 수 없습니다.',
  }],
});

const slackEvidenceLocations: Array<[
  string,
  (report: ReturnType<typeof makeReport>, evidence: ReviewEvidence) => void,
]> = [
  ['change evidence', (report, evidence) => report.changeSummary.changes[0].evidence.push(evidence)],
  ['graph node evidence', (report, evidence) => report.flowGraph.nodes[0].evidence.push(evidence)],
  ['graph edge evidence', (report, evidence) => report.flowGraph.edges[0].evidence.push(evidence)],
  ['check evidence', (report, evidence) => report.checks[0].evidence.push(evidence)],
  ['analysis proposal provenance', (report, evidence) => report.decisionOptions[0].provenance.push(evidence)],
];

const slackEvidence = (url: string): ReviewEvidence => ({
  kind: 'slack',
  label: 'Slack note',
  detail: 'Slack evidence used to test permalink cross-referencing.',
  url,
});

describe('normalizeReviewReport', () => {
  it('normalizes the bounded decision-support schema and preserves evidence provenance', () => {
    const input = makeReport();
    input.metadata.title = '  결제 경로 개선  ';

    const report = normalizeReviewReport(input);

    expect(report.metadata.title).toBe('결제 경로 개선');
    expect(report.metadata.generatedAt).toBe('2026-10-21T02:00:00.000Z');
    expect(report.executiveSummary.overallRisk.level).toBe('medium');
    expect(report.changeSummary.changes[0].before).toContain('빈 식별자');
    expect(report.flowGraph.edges[0].evidence[0].path).toBe('src/payments/controller.ts');
    expect(report.decisionOptions[0].assumptions).toEqual(['상위 API가 빈 값을 허용하지 않습니다.']);
    expect(report.impactScope.unknown).toHaveLength(1);
    expect(report.checks.map((check: { status: string }) => check.status)).toEqual(['passed', 'failed', 'blocked', 'not_run']);
    expect(report.slack.status).toBe('available');
  });

  it('rejects missing sections, invalid enum states, and non-explicit Slack availability', () => {
    const missing = makeReport() as Record<string, unknown>;
    delete missing.humanChecklist;
    expect(() => normalizeReviewReport(missing)).toThrow('invalid review report');

    const badStatus = makeReport();
    badStatus.checks[0].status = 'success' as typeof badStatus.checks[0]['status'];
    expect(() => normalizeReviewReport(badStatus)).toThrow('invalid review report');

    const badSlack = makeReport();
    badSlack.slack.status = 'unknown' as typeof badSlack.slack.status;
    expect(() => normalizeReviewReport(badSlack)).toThrow('invalid review report');
  });

  it('rejects overlong strings and oversized section arrays', () => {
    const longText = makeReport();
    longText.changeSummary.overview = 'x'.repeat(5000);
    expect(() => normalizeReviewReport(longText)).toThrow('invalid review report');

    const tooManyRisks = makeReport();
    tooManyRisks.risks = Array.from({ length: 21 }, (_, index) => ({
      level: 'low' as const,
      title: `Risk ${index}`,
      rationale: '근거',
      mitigations: [],
    }));
    expect(() => normalizeReviewReport(tooManyRisks)).toThrow('invalid review report');

    const tooManyNodes = makeReport();
    tooManyNodes.flowGraph.nodes = Array.from({ length: 31 }, (_, index) => ({
      id: `node-${index}`,
      label: `노드 ${index}`,
      evidence: [{ kind: 'code' as const, label: '근거', detail: '코드 위치 확인' }],
    }));
    tooManyNodes.flowGraph.edges = [];
    expect(() => normalizeReviewReport(tooManyNodes)).toThrow('invalid review report');
  });

  it('rejects duplicate graph node IDs and edges with missing endpoints', () => {
    const duplicate = makeReport();
    duplicate.flowGraph.nodes[1].id = duplicate.flowGraph.nodes[0].id;
    expect(() => normalizeReviewReport(duplicate)).toThrow('duplicate flow graph node id');

    const dangling = makeReport();
    dangling.flowGraph.edges[0].to = 'missing-node';
    expect(() => normalizeReviewReport(dangling)).toThrow('dangling flow graph edge');
  });

  it('requires source evidence for changes, graph nodes, graph edges, and decision provenance', () => {
    const noChangeEvidence = makeReport();
    noChangeEvidence.changeSummary.changes[0].evidence = [];
    expect(() => normalizeReviewReport(noChangeEvidence)).toThrow('invalid review report');

    const noNodeEvidence = makeReport();
    noNodeEvidence.flowGraph.nodes[0].evidence = [];
    expect(() => normalizeReviewReport(noNodeEvidence)).toThrow('invalid review report');

    const noEdgeEvidence = makeReport();
    noEdgeEvidence.flowGraph.edges[0].evidence = [];
    expect(() => normalizeReviewReport(noEdgeEvidence)).toThrow('invalid review report');

    const noProvenance = makeReport();
    noProvenance.decisionOptions[0].provenance = [];
    expect(() => normalizeReviewReport(noProvenance)).toThrow('invalid review report');
  });

  it('allows an empty change list instead of requiring fabricated before-and-after evidence', () => {
    const emptyChanges = makeReport();
    emptyChanges.changeSummary.changes = [];
    expect(normalizeReviewReport(emptyChanges).changeSummary.changes).toEqual([]);
  });

  it('requires an executive summary with an overall risk and mitigation', () => {
    const missingSummary = makeReport();
    delete missingSummary.executiveSummary;
    expect(() => normalizeReviewReport(missingSummary)).toThrow('invalid review report');

    const missingMitigation = makeReport();
    missingMitigation.executiveSummary.overallRisk.mitigations = [];
    expect(() => normalizeReviewReport(missingMitigation)).toThrow('invalid review report');
  });

  it('requires decision provenance and non-empty benefits and drawbacks', () => {
    for (const field of ['benefits', 'drawbacks']) {
      const emptyTradeoff = makeReport();
      emptyTradeoff.decisionOptions[0][field] = [];
      expect(() => normalizeReviewReport(emptyTradeoff)).toThrow('invalid review report');
    }

    const noAssumptions = makeReport();
    noAssumptions.decisionOptions[0].assumptions = [];
    expect(() => normalizeReviewReport(noAssumptions)).not.toThrow();

    const unsupportedSlackAssumptions = makeReport();
    unsupportedSlackAssumptions.decisionOptions[0].source = 'slack_team_discussion';
    unsupportedSlackAssumptions.decisionOptions[0].status = 'decision';
    unsupportedSlackAssumptions.decisionOptions[0].provenance = [{
      kind: 'slack', label: '팀 논의', detail: '결정 근거', url: unsupportedSlackAssumptions.slack.items[0].permalink,
    }];
    unsupportedSlackAssumptions.decisionOptions[0].assumptions = [];
    expect(() => normalizeReviewReport(unsupportedSlackAssumptions)).toThrow('invalid review report');

    const ambiguousSource = makeReport();
    ambiguousSource.decisionOptions[0].source = 'analysis_proposal';
    ambiguousSource.decisionOptions[0].status = 'decision';
    expect(() => normalizeReviewReport(ambiguousSource)).toThrow('invalid review report');
  });

  it('requires Slack-sourced decisions to match an available cited Slack context', () => {
    const citedDiscussion = makeReport();
    citedDiscussion.decisionOptions[0].source = 'slack_team_discussion';
    citedDiscussion.decisionOptions[0].status = 'decision';
    citedDiscussion.decisionOptions[0].provenance = [{
      kind: 'slack',
      label: '팀 합의',
      detail: '기존 호출 계약을 유지하기로 했습니다.',
      url: citedDiscussion.slack.items[0].permalink,
    }];
    expect(() => normalizeReviewReport(citedDiscussion)).not.toThrow();

    const missingContext = makeReport();
    missingContext.decisionOptions[0].source = 'slack_team_discussion';
    missingContext.decisionOptions[0].status = 'decision';
    missingContext.decisionOptions[0].provenance = citedDiscussion.decisionOptions[0].provenance;
    missingContext.slack = { status: 'not_found', items: [] };
    expect(() => normalizeReviewReport(missingContext)).toThrow('invalid review report');
  });

  it.each(slackEvidenceLocations)('rejects unmatched Slack evidence in %s', (label, addEvidence) => {
    const report = makeReport();
    addEvidence(report, slackEvidence('https://acme.slack.com/archives/C999/p1729500000000000'));

    expect(() => normalizeReviewReport(report)).toThrow(`unmatched Slack evidence in ${label}`);
  });

  it.each(slackEvidenceLocations)('accepts exact Slack permalink evidence in %s', (_label, addEvidence) => {
    const report = makeReport();
    addEvidence(report, slackEvidence(report.slack.items[0].permalink));

    expect(() => normalizeReviewReport(report)).not.toThrow();
  });

  it.each(slackEvidenceLocations)('rejects Slack evidence in %s when Slack is unavailable', (_label, addEvidence) => {
    const report = makeReport();
    const citedPermalink = report.slack.items[0].permalink;
    report.slack = { status: 'unavailable', items: [], note: 'Slack context was not available.' };
    addEvidence(report, slackEvidence(citedPermalink));

    expect(() => normalizeReviewReport(report)).toThrow('Slack evidence requires an available matching permalink');
  });

  it('requires a grounded graph or an explicit unavailable/not-applicable explanation', () => {
    const emptyAvailable = makeReport();
    emptyAvailable.flowGraph = { status: 'available', nodes: [], edges: [] };
    expect(() => normalizeReviewReport(emptyAvailable)).toThrow('invalid review report');

    const unsupported = makeReport();
    unsupported.flowGraph = { status: 'unavailable', nodes: [], edges: [] };
    expect(() => normalizeReviewReport(unsupported)).toThrow('invalid review report');

    const explicitUnavailable = makeReport();
    explicitUnavailable.flowGraph = {
      status: 'not_applicable',
      note: '이번 변경은 정적 데이터 문구만 수정하여 호출 흐름이 없습니다.',
      nodes: [],
      edges: [],
    };
    expect(normalizeReviewReport(explicitUnavailable).flowGraph.status).toBe('not_applicable');
  });

  it('requires at least one explicit test or CI status', () => {
    const noChecks = makeReport();
    noChecks.checks = [];
    expect(() => normalizeReviewReport(noChecks)).toThrow('invalid review report');
  });

  it('accepts only validated GitHub source URLs and Slack workspace permalinks', () => {
    const safe = makeReport();
    safe.changeSummary.changes[0].evidence[0].url = 'https://github.com/acme/payments/pull/17/files';
    safe.slack.items[0].permalink = 'https://app.slack.com/archives/T123/C123/p1729500000000000';
    expect(() => normalizeReviewReport(safe)).not.toThrow();

    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<svg>',
      '//github.com/acme/payments/pull/17',
      'https://github.com.evil.example/acme/payments/pull/17',
      'https://github.com:8443/acme/payments/pull/17',
      'https://%zz',
    ]) {
      const unsafe = makeReport();
      unsafe.changeSummary.changes[0].evidence[0].url = url;
      expect(() => normalizeReviewReport(unsafe)).toThrow('invalid review report');
    }

    for (const permalink of [
      'javascript:alert(1)',
      'data:text/html,<svg>',
      '//acme.slack.com/archives/C123/p1729500000000000',
      'https://slack.com/archives/C123/p1729500000000000',
      'https://acme.slack.com.evil.example/archives/C123/p1729500000000000',
      'https://acme.slack.com:8443/archives/C123/p1729500000000000',
    ]) {
      const unsafe = makeReport();
      unsafe.slack.items[0].permalink = permalink;
      expect(() => normalizeReviewReport(unsafe)).toThrow('invalid review report');
    }
  });

  it('rejects impossible ISO calendar dates in generated and Slack timestamps', () => {
    const invalidGeneratedAt = makeReport();
    invalidGeneratedAt.metadata.generatedAt = '2026-02-31T02:00:00.000Z';
    expect(() => normalizeReviewReport(invalidGeneratedAt)).toThrow('invalid review report');

    const invalidSlackTimestamp = makeReport();
    invalidSlackTimestamp.slack.items[0].timestamp = '2026-02-31T01:00:00.000Z';
    expect(() => normalizeReviewReport(invalidSlackTimestamp)).toThrow('invalid review report');
  });

  it('requires an explicit unavailable or not-found state when Slack has no items', () => {
    const unavailable = makeReport();
    unavailable.slack = { status: 'unavailable', items: [], note: 'Slack 연결을 사용할 수 없습니다.' };
    expect(normalizeReviewReport(unavailable).slack.status).toBe('unavailable');

    const notFound = makeReport();
    notFound.slack = { status: 'not_found', items: [] };
    expect(normalizeReviewReport(notFound).slack.status).toBe('not_found');

    const ambiguous = makeReport();
    ambiguous.slack = { status: 'available', items: [] };
    expect(() => normalizeReviewReport(ambiguous)).toThrow('invalid review report');
  });
});
