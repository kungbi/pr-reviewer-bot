import { renderReviewReportHtml } from '../src/review/review-report-renderer';

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
    owner: 'acme', repository: 'payments', pullRequestNumber: 17,
    title: '결제 경로 개선', baseRef: 'main', baseSha: 'a'.repeat(40),
    headRef: 'feat/reconcile', headSha: 'b'.repeat(40), generatedAt: '2026-10-21T02:00:00.000Z',
  },
  changeSummary: {
    overview: '요청 검증에서 저장까지의 흐름을 요약합니다.',
    changes: [{
      title: '요청 입력 검증 추가', before: '빈 식별자가 저장 계층까지 전달됩니다.',
      after: '빈 식별자를 컨트롤러에서 거부합니다.', evidence: [{
        kind: 'diff', label: 'PR diff', detail: '요청 필드 검증 변경',
        path: 'src/payments/controller.ts', startLine: 10, endLine: 14,
        url: 'https://github.com/acme/payments/pull/17/files',
      }],
    }],
  },
  flowGraph: {
    status: 'available',
    nodes: [
      { id: 'request', label: '요청 검증', evidence: [{ kind: 'code', label: '컨트롤러 검사', detail: '빈 값 분기 확인', path: 'src/payments/controller.ts', startLine: 10 }] },
      { id: 'store', label: '저장소 갱신', evidence: [{ kind: 'code', label: '저장 호출', detail: '검증된 요청 전달', path: 'src/payments/store.ts', startLine: 31 }] },
    ],
    edges: [{ from: 'request', to: 'store', label: '통과한 요청 전달', evidence: [{ kind: 'code', label: '호출 연결', detail: '컨트롤러에서 저장소 호출' }] }],
  },
  decisionOptions: [{
    id: 'current', title: '현재 변경 범위 유지', description: '검증 변경을 이번 PR에 한정합니다.',
    source: 'analysis_proposal', status: 'proposal',
    benefits: ['수정 범위가 작습니다.'], drawbacks: ['하위 호출자 계약은 별도 확인이 필요합니다.'],
    assumptions: ['상위 API가 빈 값을 허용하지 않습니다.'],
    provenance: [{ kind: 'code', label: '호출자 계약', detail: 'API 타입과 검증 위치 비교', path: 'src/payments/controller.ts' }],
  }],
  impactScope: {
    proven: ['컨트롤러 입력 검증이 추가됩니다.'],
    inferred: ['잘못된 저장 시도가 줄어들 수 있습니다.'],
    unknown: ['운영 데이터의 발생 빈도는 알 수 없습니다.'],
  },
  risks: [{ level: 'high', title: '호출자 입력 불일치', rationale: '기존 호출자가 빈 값을 보낼 수 있습니다.', mitigations: ['호출자 목록을 확인합니다.'] }],
  checks: [
    { name: 'TypeScript build', status: 'passed', details: '컴파일 성공', evidence: [] },
    { name: 'Integration tests', status: 'failed', details: '한 테스트가 실패했습니다.', evidence: [] },
    { name: 'Deployment check', status: 'blocked', details: '환경에 접근할 수 없습니다.', evidence: [] },
    { name: 'Load tests', status: 'not_run', details: '이번 검토에서 실행하지 않았습니다.', evidence: [] },
  ],
  slack: {
    status: 'available', items: [{
      summary: '호출자 계약 논의', permalink: 'https://acme.slack.com/archives/C123/p1729500000000000',
    }],
  },
  humanChecklist: [{ id: 'runtime-contract', question: '운영 호출자가 동일한 입력 계약을 따르는지 확인했나요?' }],
});

describe('renderReviewReportHtml', () => {
  it('renders a responsive Korean report with visible evidence, uncertainty, risk, and test labels', () => {
    const html = renderReviewReportHtml(makeReport());

    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<html lang="ko">');
    expect(html).toContain('사람 검토 메모');
    expect(html).toContain('요청 검증 경로를 좁혀 입력 오류를 저장 전에 차단합니다.');
    expect(html).toContain('사람이 결정할 항목');
    expect(html).toContain('전체 위험도');
    expect(html).toContain('출처: 분석 제안');
    expect(html).toContain('확인된 영향');
    expect(html).toContain('추정 영향');
    expect(html).toContain('미확인 영향');
    expect(html).toContain('근거');
    expect(html).toContain('위험');
    expect(html).toContain('높음');
    expect(html).toContain('통과');
    expect(html).toContain('실패');
    expect(html).toContain('차단됨');
    expect(html).toContain('미실행');
    expect(html).toContain('Slack');
    expect(html).toContain('사람이 확인할 항목');
    expect(html).toContain('<svg');
    expect(html).toContain('<line');
    expect(html).toContain('<text');
    expect(html).toContain('href="https://github.com/acme/payments/pull/17"');
  });

  it('escapes untrusted content in HTML and SVG text and rejects unsafe links', () => {
    const report = makeReport();
    const payload = `</script><img src=x onerror="alert('x')"> &`;
    report.metadata.title = payload;
    report.executiveSummary.conclusion = payload;
    report.executiveSummary.requiredDecisions[0] = payload;
    report.executiveSummary.overallRisk.title = payload;
    report.executiveSummary.overallRisk.mitigations[0] = payload;
    report.changeSummary.overview = payload;
    report.changeSummary.changes[0].after = payload;
    report.flowGraph.nodes[0].label = payload;
    report.flowGraph.nodes[0].evidence[0].label = payload;
    report.decisionOptions[0].title = payload;
    report.impactScope.unknown[0] = payload;
    report.risks[0].rationale = payload;
    report.checks[0].details = payload;
    report.slack.items[0].summary = payload;
    report.slack.items[0].author = payload;
    report.humanChecklist[0].question = payload;

    const html = renderReviewReportHtml(report);

    expect(html).toContain('&lt;/script&gt;&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt; &amp;');
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
    expect(html).not.toContain(payload);

    const unsafe = makeReport();
    unsafe.slack.items[0].permalink = 'javascript:alert(1)';
    expect(() => renderReviewReportHtml(unsafe)).toThrow('invalid review report');
  });

  it('emits no scripts, external assets, inline handlers, or raw HTML supplied as data', () => {
    const html = renderReviewReportHtml(makeReport());

    expect(html).not.toMatch(/<script\b|<iframe\b|<img\b|<link\b/i);
    expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/<style[^>]*src=/i);
    expect(html).not.toContain('https://fonts.googleapis.com');
    expect(html).not.toContain('REQUEST_CHANGES');
    expect(html).not.toContain('APPROVE');
    expect(html).toContain('결정은 담당자가 내립니다');
  });

  it('renders verified review findings and isolated runner stages as escaped text', () => {
    const report = makeReport() as Record<string, any>;
    const payload = `<img src=x onerror="alert(1)">`;
    report.reviewFindings = [
      {
        source: 'inline_comment', status: 'finding', severity: 'important', confidence: 'confirmed',
        path: 'src/payments/controller.ts', line: 12, side: 'RIGHT', body: payload,
      },
      {
        source: 'existing_thread', status: 'uncertain', severity: 'unknown', confidence: 'uncertain',
        threadId: 41, body: '현재 적용 여부를 확인할 근거가 부족합니다.',
      },
    ];
    report.reviewFindingsOmitted = 2;
    report.testRunner = {
      runtime: '22.2.0', selectedCommand: 'npm run test:unit', status: 'blocked',
      reason: 'Docker is unavailable.',
      install: { status: 'blocked', reason: 'Docker daemon is unavailable.' },
      test: { status: 'not_run', reason: 'Install did not pass.' },
    };

    const html = renderReviewReportHtml(report);

    expect(html).toContain('검증된 리뷰 항목');
    expect(html).toContain('src/payments/controller.ts:12');
    expect(html).toContain('기존 스레드 #41');
    expect(html).toContain('중요');
    expect(html).toContain('확인됨');
    expect(html).toContain('검증된 리뷰 항목 2개는 보고서 한도로 생략했습니다.');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).not.toContain(payload);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).toContain('Node.js 22.2.0');
    expect(html).toContain('npm run test:unit');
    expect(html).toContain('Docker daemon is unavailable.');
    expect(html).toContain('Install did not pass.');
    expect(html).toContain('차단됨');
    expect(html).toContain('미실행');
  });

  it('renders a diff hunk with an absent side as absent instead of fabricated text', () => {
    const report = makeReport() as Record<string, any>;
    report.changeHunksOmitted = 1;
    report.changeSummary.changes.push({
      title: '새 코드 추가',
      after: 'export const added = true;',
      evidence: [{
        kind: 'diff', label: 'PR diff hunk', detail: 'Added lines from the fetched PR diff.',
        path: 'src/new.ts', side: 'RIGHT', startLine: 1, endLine: 1,
        url: 'https://github.com/acme/payments/pull/17/files',
      }],
    });

    const html = renderReviewReportHtml(report);

    expect(html).toContain('이 hunk에 변경 전 줄이 없습니다.');
    expect(html).toContain('export const added = true;');
    expect(html).toContain('변경 후');
    expect(html).toContain('보고서 한도로 1개 변경 hunk를 생략했습니다.');
  });

  it('renders explicit Slack unavailable and not-found states without inventing messages', () => {
    const report = makeReport();
    report.slack = { status: 'unavailable', items: [], note: '연결을 사용할 수 없습니다.' };
    const unavailable = renderReviewReportHtml(report);
    expect(unavailable).toContain('사용 불가');
    expect(unavailable).toContain('연결을 사용할 수 없습니다.');

    report.slack = { status: 'not_found', items: [] };
    const notFound = renderReviewReportHtml(report);
    expect(notFound).toContain('검색 결과 없음');
  });

  it('labels Slack team decisions separately from analysis proposals', () => {
    const report = makeReport();
    report.decisionOptions[0].source = 'slack_team_discussion';
    report.decisionOptions[0].status = 'decision';
    report.decisionOptions[0].provenance = [{
      kind: 'slack',
      label: '팀 합의',
      detail: '기존 호출 계약을 유지하기로 했습니다.',
      url: report.slack.items[0].permalink,
    }];

    const html = renderReviewReportHtml(report);
    expect(html).toContain('출처: Slack 팀 논의');
    expect(html).toContain('상태: 확정 결정');
    expect(html).toContain('>Slack 대화</a>');
  });

  it('renders analysis proposal provenance, tradeoffs, and scope without implying a Slack decision', () => {
    const report = makeReport();
    report.decisionOptions[0].convention = '인접 코드에서 공유 검증 함수를 사용합니다.';
    report.decisionOptions[0].scope = 'follow_up';
    report.decisionOptionsOmitted = 1;

    const html = renderReviewReportHtml(report);

    expect(html).toContain('출처: 분석 제안');
    expect(html).toContain('컨벤션 근거');
    expect(html).toContain('인접 코드에서 공유 검증 함수를 사용합니다.');
    expect(html).toContain('후속 작업');
    expect(html).toContain('1개 제안의 trade-off는 보고서 한도로 생략했습니다.');

    report.decisionOptions = [];
    delete report.decisionOptionsOmitted;
    const noProposal = renderReviewReportHtml(report);
    expect(noProposal).toContain('검증된 제안이 없습니다.');
  });

  it('renders explicit unavailable flow as text and refuses forged graph edges', () => {
    const empty = makeReport();
    empty.flowGraph = {
      status: 'unavailable',
      note: '코드 근거로 흐름을 특정할 수 없습니다.',
      nodes: [],
      edges: [],
    };
    const html = renderReviewReportHtml(empty);
    expect(html).toContain('시각화 상태: 사용 불가');
    expect(html).toContain('코드 근거로 흐름을 특정할 수 없습니다.');
    expect(html).not.toContain('<svg');

    const forged = makeReport();
    forged.flowGraph.edges[0].to = 'unknown';
    expect(() => renderReviewReportHtml(forged)).toThrow('dangling flow graph edge');
  });
});
