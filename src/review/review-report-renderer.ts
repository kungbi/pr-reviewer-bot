import { normalizeReviewReport } from './review-report';
import type { ReviewEvidence, ReviewFlowEdge, ReviewFlowGraph, ReviewFlowNode, ReviewReport } from '../types/review-report.types';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return character;
    }
  });
}

function attribute(value: string | number): string {
  return escapeHtml(String(value));
}

function renderStringList(items: string[], emptyLabel = '기록된 항목이 없습니다.'): string {
  if (items.length === 0) return `<p class="empty-state">${escapeHtml(emptyLabel)}</p>`;
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function renderEvidence(evidence: ReviewEvidence[]): string {
  if (evidence.length === 0) return '<p class="empty-state">연결된 근거가 없습니다.</p>';
  return `<ul class="evidence-list">${evidence.map((item) => {
    const sideLabel = item.side === undefined ? '' : item.side === 'LEFT' ? ' (변경 전)' : ' (변경 후)';
    const path = item.path === undefined
      ? ''
      : `<span class="evidence-path">경로${sideLabel}: <code>${escapeHtml(item.path)}${item.startLine === undefined ? '' : `:${attribute(item.startLine)}${item.endLine === undefined || item.endLine === item.startLine ? '' : `-${attribute(item.endLine)}`}`}</code></span>`;
    const link = item.url === undefined
      ? ''
      : `<a class="source-link" href="${attribute(item.url)}" rel="noreferrer noopener">${item.kind === 'slack' ? 'Slack 대화' : 'GitHub 근거'}</a>`;
    return `<li class="evidence-item"><span class="badge evidence-badge">근거</span><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.detail)}</span>${path}${link}</li>`;
  }).join('')}</ul>`;
}

function svgLines(value: string, maxCharacters: number): string[] {
  const characters = Array.from(value);
  const lines: string[] = [];
  for (let index = 0; index < characters.length; index += maxCharacters) {
    lines.push(characters.slice(index, index + maxCharacters).join(''));
  }
  return lines.length > 0 ? lines : [''];
}

interface NodePosition {
  x: number;
  y: number;
  width: number;
  height: number;
  labelLines: string[];
}

function renderGraph(nodes: ReviewFlowNode[], edges: ReviewFlowEdge[]): string {
  if (nodes.length === 0) return '<p class="empty-state">표시할 흐름 노드가 없습니다.</p>';

  const width = 920;
  const nodeWidth = 420;
  const rowGap = 28;
  const margin = 20;
  const prepared = nodes.map((node) => {
    const labelLines = svgLines(node.label, 28);
    return { node, labelLines, height: Math.max(76, 44 + labelLines.length * 19) };
  });
  const rowHeights: number[] = [];
  for (let index = 0; index < prepared.length; index += 2) {
    rowHeights.push(Math.max(prepared[index].height, prepared[index + 1]?.height ?? 0));
  }
  const rowTops: number[] = [];
  let currentY = margin;
  for (const rowHeight of rowHeights) {
    rowTops.push(currentY);
    currentY += rowHeight + rowGap;
  }
  const positions = new Map<string, NodePosition>();
  prepared.forEach(({ node, labelLines, height }, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    positions.set(node.id, {
      x: margin + column * (nodeWidth + 40),
      y: rowTops[row],
      width: nodeWidth,
      height,
      labelLines,
    });
  });
  const svgHeight = Math.max(120, currentY - rowGap + margin);
  const edgeMarkup = edges.map((edge) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) return '';
    const x1 = from.x + from.width / 2;
    const y1 = from.y + from.height / 2;
    const x2 = to.x + to.width / 2;
    const y2 = to.y + to.height / 2;
    const labelLines = svgLines(edge.label, 30);
    const label = labelLines.map((line, index) =>
      `<tspan x="${attribute((x1 + x2) / 2)}" dy="${attribute(index === 0 ? 0 : 16)}">${escapeHtml(line)}</tspan>`,
    ).join('');
    return `<g class="flow-edge"><line x1="${attribute(x1)}" y1="${attribute(y1)}" x2="${attribute(x2)}" y2="${attribute(y2)}" marker-end="url(#flow-arrow)"/><text x="${attribute((x1 + x2) / 2)}" y="${attribute((y1 + y2) / 2)}" text-anchor="middle">${label}</text></g>`;
  }).join('');
  const nodeMarkup = prepared.map(({ node }, index) => {
    const position = positions.get(node.id);
    if (!position) return '';
    const textLines = position.labelLines.map((line, lineIndex) =>
      `<tspan x="${attribute(position.x + 20)}" dy="${attribute(lineIndex === 0 ? 0 : 19)}">${escapeHtml(line)}</tspan>`,
    ).join('');
    return `<g class="flow-node"><rect x="${attribute(position.x)}" y="${attribute(position.y)}" width="${attribute(position.width)}" height="${attribute(position.height)}" rx="12"/><text x="${attribute(position.x + 20)}" y="${attribute(position.y + 34)}"><tspan class="node-number">${attribute(index + 1)} · </tspan>${textLines}</text></g>`;
  }).join('');

  return `<div class="graph-scroll"><svg class="flow-graph" viewBox="0 0 ${attribute(width)} ${attribute(svgHeight)}" role="img" aria-labelledby="flow-title flow-description"><title id="flow-title">정적 코드 흐름</title><desc id="flow-description">검증된 노드와 간선으로 표현한 코드 흐름입니다.</desc><defs><marker id="flow-arrow" markerWidth="10" markerHeight="8" refX="8" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 z"/></marker></defs>${edgeMarkup}${nodeMarkup}</svg></div>`;
}

function renderFlowGraph(graph: ReviewFlowGraph): string {
  if (graph.status === 'available') return renderGraph(graph.nodes, graph.edges);
  const label = graph.status === 'unavailable' ? '사용 불가' : '해당 없음';
  return `<p class="empty-state">시각화 상태: ${escapeHtml(label)}</p><p>${escapeHtml(graph.note ?? '')}</p>`;
}

function renderGraphEvidence(report: ReviewReport): string {
  const groups = [
    ...report.flowGraph.nodes.map((node) => ({ title: `노드: ${node.label}`, evidence: node.evidence })),
    ...report.flowGraph.edges.map((edge) => ({ title: `간선: ${edge.label}`, evidence: edge.evidence })),
  ];
  if (groups.length === 0) return '';
  return `<details class="graph-evidence"><summary>흐름 그래프의 근거 (${attribute(groups.length)})</summary>${groups.map((group) =>
    `<section class="graph-evidence-group"><h3>${escapeHtml(group.title)}</h3>${renderEvidence(group.evidence)}</section>`,
  ).join('')}</details>`;
}

function renderChangeSummary(report: ReviewReport): string {
  const changes = report.changeSummary.changes.length === 0
    ? '<p class="empty-state">가져온 diff에서 표시할 텍스트 변경 hunk가 없습니다.</p>'
    : report.changeSummary.changes.map((change) => {
      if (change.nonTextual !== undefined) return `<article class="change-card"><h3>${escapeHtml(change.title)}</h3><p>텍스트 내용은 확인할 수 없습니다. diff 메타데이터만 표시합니다.</p><h4>변경 근거</h4>${renderEvidence(change.evidence)}</article>`;
      const before = change.before === undefined
        ? '이 hunk에 변경 전 줄이 없습니다.'
        : change.before === '' ? '변경된 줄이 빈 줄입니다.' : change.before;
      const after = change.after === undefined
        ? '이 hunk에 변경 후 줄이 없습니다.'
        : change.after === '' ? '변경된 줄이 빈 줄입니다.' : change.after;
      return `<article class="change-card"><h3>${escapeHtml(change.title)}</h3><div class="before-after"><div><h4>변경 전</h4><pre>${escapeHtml(before)}</pre></div><div><h4>변경 후</h4><pre>${escapeHtml(after)}</pre></div></div><h4>변경 근거</h4>${renderEvidence(change.evidence)}</article>`;
    }).join('');
  const omittedNote = report.changeHunksOmitted === undefined
    ? ''
    : `<p class="empty-state">보고서 한도로 ${attribute(report.changeHunksOmitted)}개 변경 hunk를 생략했습니다.</p>`;
  return `<section class="report-section"><h2>변경 요약</h2><p class="section-intro">${escapeHtml(report.changeSummary.overview)}</p>${changes}${omittedNote}</section>`;
}

function renderExecutiveSummary(report: ReviewReport): string {
  const summary = report.executiveSummary;
  const risk = summary.overallRisk;
  return `<section class="report-section executive-summary"><h2>핵심 요약</h2><p class="section-intro">${escapeHtml(summary.conclusion)}</p><article class="risk-card"><p><span class="badge risk-badge risk-${attribute(risk.level)}">전체 위험도 · ${escapeHtml(riskLabel(risk.level))}</span></p><h3>${escapeHtml(risk.title)}</h3><p>${escapeHtml(risk.rationale)}</p><h4>완화 방안</h4>${renderStringList(risk.mitigations)}</article><h3>사람이 결정할 항목</h3>${renderStringList(summary.requiredDecisions)}</section>`;
}

function decisionSourceLabel(source: ReviewReport['decisionOptions'][number]['source']): string {
  return source === 'slack_team_discussion' ? 'Slack 팀 논의' : '분석 제안';
}

function decisionStatusLabel(status: ReviewReport['decisionOptions'][number]['status']): string {
  const labels: Record<ReviewReport['decisionOptions'][number]['status'], string> = {
    decision: '확정 결정',
    proposal: '제안',
    rejected: '기각/대체됨',
    unresolved: '미해결',
  };
  return labels[status];
}

function proposalScopeLabel(scope: 'current_pr' | 'follow_up'): string {
  return scope === 'current_pr' ? '이번 PR' : '후속 작업';
}

function renderDecisionOptions(report: ReviewReport): string {
  if (report.decisionOptions.length === 0) {
    const omitted = report.decisionOptionsOmitted === undefined
      ? '<p class="empty-state">검증된 제안이 없습니다.</p>'
      : `<p class="empty-state">제안 trade-off ${attribute(report.decisionOptionsOmitted)}개가 보고서 한도로 생략되었습니다.</p>`;
    return `<section class="report-section"><h2>검토할 선택지</h2>${omitted}</section>`;
  }
  const options = report.decisionOptions.map((option, index) => `<article class="option-card"><p class="eyebrow">선택지 ${attribute(index + 1)} · 출처: ${escapeHtml(decisionSourceLabel(option.source))} · 상태: ${escapeHtml(decisionStatusLabel(option.status))}</p><h3>${escapeHtml(option.title)}</h3>${option.description === undefined ? '' : `<p>${escapeHtml(option.description)}</p>`}<div class="option-columns"><div><h4>이점</h4>${renderStringList(option.benefits)}</div><div><h4>단점</h4>${renderStringList(option.drawbacks)}</div><div><h4>가정</h4>${renderStringList(option.assumptions)}</div></div>${option.convention === undefined ? '' : `<h4>컨벤션 근거</h4><p>${escapeHtml(option.convention)}</p>`}${option.scope === undefined ? '' : `<p><strong>제안 범위:</strong> ${escapeHtml(proposalScopeLabel(option.scope))}</p>`}<h4>출처 근거</h4>${renderEvidence(option.provenance)}</article>`).join('');
  const omittedNote = report.decisionOptionsOmitted === undefined
    ? ''
    : `<p class="empty-state">${attribute(report.decisionOptionsOmitted)}개 제안의 trade-off는 보고서 한도로 생략했습니다.</p>`;
  return `<section class="report-section"><h2>검토할 선택지</h2>${options}${omittedNote}</section>`;
}

function findingSourceLabel(source: NonNullable<ReviewReport['reviewFindings']>[number]['source']): string {
  const labels: Record<NonNullable<ReviewReport['reviewFindings']>[number]['source'], string> = {
    inline_comment: '인라인 리뷰',
    thread_reply: '기존 스레드 답글',
    existing_thread: '기존 스레드 평가',
  };
  return labels[source];
}

function findingStatusLabel(status: NonNullable<ReviewReport['reviewFindings']>[number]['status']): string {
  const labels: Record<NonNullable<ReviewReport['reviewFindings']>[number]['status'], string> = {
    finding: 'Finding',
    proposal: '제안',
    reply: '답글',
    still_applies: '여전히 적용됨',
    fixed_in_code: '코드에서 수정됨',
    not_actionable: '조치 대상 아님',
    uncertain: '불확실',
  };
  return labels[status];
}

function findingSeverityLabel(severity: NonNullable<ReviewReport['reviewFindings']>[number]['severity']): string {
  const labels: Record<NonNullable<ReviewReport['reviewFindings']>[number]['severity'], string> = {
    blocker: 'Blocker', important: '중요', minor: '경미', unknown: '미정',
  };
  return labels[severity];
}

function findingConfidenceLabel(confidence: NonNullable<ReviewReport['reviewFindings']>[number]['confidence']): string {
  const labels: Record<NonNullable<ReviewReport['reviewFindings']>[number]['confidence'], string> = {
    confirmed: '확인됨', uncertain: '불확실', not_recorded: '확신도 기록 없음',
  };
  return labels[confidence];
}

function renderReviewFindings(report: ReviewReport): string {
  const findings = report.reviewFindings ?? [];
  const omittedNote = report.reviewFindingsOmitted === undefined
    ? ''
    : `<p class="empty-state">검증된 리뷰 항목 ${attribute(report.reviewFindingsOmitted)}개는 보고서 한도로 생략했습니다.</p>`;
  if (findings.length === 0) {
    const empty = report.reviewFindingsOmitted === undefined
      ? '검증된 finding, 답글, 기존 스레드 평가가 없습니다.'
      : `검증된 리뷰 항목 ${report.reviewFindingsOmitted}개가 보고서 한도로 생략되었습니다.`;
    return `<section class="report-section"><h2>검증된 리뷰 항목</h2><p class="empty-state">${escapeHtml(empty)}</p></section>`;
  }
  const items = findings.map((finding) => {
    const location = finding.path === undefined
      ? ''
      : `<span class="finding-location">경로: <code>${escapeHtml(finding.path)}${finding.line === undefined ? '' : `:${attribute(finding.line)}`}${finding.side === undefined ? '' : ` (${finding.side === 'LEFT' ? '변경 전' : '변경 후'})`}</code></span>`;
    const thread = finding.threadId === undefined ? '' : `<span class="finding-thread">기존 스레드 #${attribute(finding.threadId)}</span>`;
    const reason = finding.uncertaintyReason === undefined ? '' : `<p class="finding-body"><strong>확신하지 못한 이유:</strong> ${escapeHtml(finding.uncertaintyReason)}</p>`;
    return `<article class="finding-card"><p class="eyebrow">${escapeHtml(findingSourceLabel(finding.source))} · ${escapeHtml(findingStatusLabel(finding.status))}</p><p><span class="badge severity-badge">심각도 · ${escapeHtml(findingSeverityLabel(finding.severity))}</span> <span class="badge confidence-badge">확신도 · ${escapeHtml(findingConfidenceLabel(finding.confidence))}</span></p>${location}${thread}<p class="finding-body">${escapeHtml(finding.body)}</p>${reason}</article>`;
  }).join('');
  return `<section class="report-section"><h2>검증된 리뷰 항목</h2>${items}${omittedNote}</section>`;
}

function renderImpactScope(report: ReviewReport): string {
  const groups: Array<{ title: string; className: string; items: string[]; empty: string }> = [
    { title: '확인된 영향 · 근거', className: 'impact-proven', items: report.impactScope.proven, empty: '확인된 영향이 없습니다.' },
    { title: '추정 영향 · 추론', className: 'impact-inferred', items: report.impactScope.inferred, empty: '추정된 영향이 없습니다.' },
    { title: '미확인 영향 · 알 수 없음', className: 'impact-unknown', items: report.impactScope.unknown, empty: '미확인 항목이 없습니다.' },
  ];
  return `<section class="report-section"><h2>영향 범위</h2><div class="impact-grid">${groups.map((group) => `<article class="impact-card ${attribute(group.className)}"><h3>${escapeHtml(group.title)}</h3>${renderStringList(group.items, group.empty)}</article>`).join('')}</div></section>`;
}

function riskLabel(level: ReviewReport['risks'][number]['level']): string {
  const labels: Record<ReviewReport['risks'][number]['level'], string> = {
    low: '낮음', medium: '중간', high: '높음', critical: '매우 높음', unknown: '미확정',
  };
  return labels[level];
}

function renderRisks(report: ReviewReport): string {
  if (report.risks.length === 0) return '<section class="report-section"><h2>위험</h2><p class="empty-state">기록된 위험 항목이 없습니다.</p></section>';
  return `<section class="report-section"><h2>위험 및 완화 방안</h2><div class="risk-list">${report.risks.map((risk) => `<article class="risk-card"><p><span class="badge risk-badge risk-${attribute(risk.level)}">위험 · ${escapeHtml(riskLabel(risk.level))}</span></p><h3>${escapeHtml(risk.title)}</h3><p>${escapeHtml(risk.rationale)}</p><h4>완화 방안</h4>${renderStringList(risk.mitigations, '완화 방안이 기록되지 않았습니다.')}</article>`).join('')}</div></section>`;
}

function checkStatusLabel(status: ReviewReport['checks'][number]['status']): string {
  const labels: Record<ReviewReport['checks'][number]['status'], string> = {
    passed: '통과', failed: '실패', blocked: '차단됨', not_run: '미실행',
  };
  return labels[status];
}

function renderTestRunner(runner: NonNullable<ReviewReport['testRunner']>): string {
  const stageCard = (title: string, stage: NonNullable<ReviewReport['testRunner']>['install']) =>
    `<article class="runner-stage"><div class="check-heading"><h3>${escapeHtml(title)}</h3><span class="badge test-status status-${attribute(stage.status)}">${escapeHtml(checkStatusLabel(stage.status))}</span></div><p>${escapeHtml(stage.reason)}</p>${stage.exitCode === undefined ? '' : `<p>종료 코드: ${attribute(stage.exitCode)}</p>`}${stage.output === undefined ? '' : `<h4>실행 출력 (민감 정보 필터링됨)</h4><pre class="runner-output">${escapeHtml(stage.output)}</pre>`}${stage.stdout === undefined ? '' : `<h4>stdout</h4><pre class="runner-output">${escapeHtml(stage.stdout)}</pre>`}${stage.stderr === undefined ? '' : `<h4>stderr</h4><pre class="runner-output">${escapeHtml(stage.stderr)}</pre>`}</article>`;
  return `<article class="check-card runner-card"><h3>격리 PR 테스트 러너</h3><p><strong>전체 상태:</strong> <span class="badge test-status status-${attribute(runner.status)}">${escapeHtml(checkStatusLabel(runner.status))}</span></p><p><strong>Node runtime:</strong> ${escapeHtml(runner.runtime === undefined ? '기록되지 않음' : `Node.js ${runner.runtime}`)}</p><p><strong>선택 명령:</strong> ${escapeHtml(runner.selectedCommand ?? '선택되지 않음')}</p><p>${escapeHtml(runner.reason)}</p><div class="runner-stages">${stageCard('설치 단계 · npm ci', runner.install)}${stageCard('테스트 단계', runner.test)}</div></article>`;
}

function renderChecks(report: ReviewReport): string {
  const runner = report.testRunner === undefined ? '' : renderTestRunner(report.testRunner);
  const checks = report.checks.length === 0
    ? ''
    : `<div class="check-list">${report.checks.map((check) => `<article class="check-card"><div class="check-heading"><h3>${escapeHtml(check.name)}</h3><span class="badge test-status status-${attribute(check.status)}">${escapeHtml(checkStatusLabel(check.status))}</span></div><p>${escapeHtml(check.details)}</p>${renderEvidence(check.evidence)}</article>`).join('')}</div>`;
  if (runner === '' && checks === '') {
    return '<section class="report-section"><h2>테스트 및 CI</h2><p class="empty-state">기록된 테스트 또는 CI 확인이 없습니다.</p></section>';
  }
  return `<section class="report-section"><h2>테스트 및 CI</h2>${runner}${checks}</section>`;
}

function renderSlack(report: ReviewReport): string {
  const statusLabel: Record<ReviewReport['slack']['status'], string> = {
    available: '관련 대화 확인', unavailable: '사용 불가', not_found: '검색 결과 없음',
  };
  const items = report.slack.items.length === 0
    ? ''
    : `<ul class="slack-list">${report.slack.items.map((item) => `<li><span>${escapeHtml(item.summary)}</span>${item.author === undefined ? '' : `<span class="slack-author">${escapeHtml(item.author)}</span>`}${item.timestamp === undefined ? '' : `<time>${escapeHtml(item.timestamp)}</time>`}<a href="${attribute(item.permalink)}" rel="noreferrer noopener">Slack 대화</a></li>`).join('')}</ul>`;
  return `<section class="report-section"><h2>Slack 상태</h2><p><span class="badge slack-status status-${attribute(report.slack.status)}">${escapeHtml(statusLabel[report.slack.status])}</span></p>${report.slack.note === undefined ? '' : `<p>${escapeHtml(report.slack.note)}</p>`}${items}</section>`;
}

function renderChecklist(report: ReviewReport): string {
  const items = report.humanChecklist.map((item) => `<li class="checklist-item"><h3>${escapeHtml(item.question)}</h3>${item.rationale === undefined ? '' : `<p>${escapeHtml(item.rationale)}</p>`}</li>`).join('');
  return `<section class="report-section"><h2>사람이 확인할 항목</h2><ol class="human-checklist">${items}</ol></section>`;
}

function renderMetadata(report: ReviewReport): string {
  const { owner, repository, pullRequestNumber, title, baseRef, baseSha, headRef, headSha, generatedAt } = report.metadata;
  const pullRequestUrl = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pull/${attribute(pullRequestNumber)}`;
  return `<header class="report-header"><p class="eyebrow">사람 검토 메모</p><h1>${escapeHtml(title)}</h1><p class="repository-line"><a href="${attribute(pullRequestUrl)}" rel="noreferrer noopener">${escapeHtml(`${owner}/${repository} #${pullRequestNumber}`)}</a></p><dl class="metadata-grid"><div><dt>기준 브랜치</dt><dd>${escapeHtml(baseRef)}</dd></div><div><dt>기준 SHA</dt><dd><code>${escapeHtml(baseSha)}</code></dd></div><div><dt>변경 브랜치</dt><dd>${escapeHtml(headRef)}</dd></div><div><dt>변경 SHA</dt><dd><code>${escapeHtml(headSha)}</code></dd></div><div><dt>생성 시각</dt><dd><time>${escapeHtml(generatedAt)}</time></dd></div></dl></header>`;
}

const CSS = `
:root{color-scheme:light;--ink:#17212b;--muted:#526170;--line:#d9e1e8;--panel:#fff;--canvas:#f4f7fa;--blue:#1d4ed8;--green:#166534;--amber:#92400e;--red:#991b1b;--violet:#5b21b6;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);line-height:1.6}main{width:min(1120px,100% - 32px);margin:32px auto 64px}.report-header,.report-section{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:24px;margin-bottom:20px;box-shadow:0 3px 14px rgba(15,23,42,.045)}h1,h2,h3,h4,p{margin-top:0}h1{font-size:clamp(1.7rem,4vw,2.5rem);line-height:1.2;margin-bottom:8px}h2{font-size:1.35rem;margin-bottom:16px}h3{font-size:1.05rem;margin-bottom:8px}h4{font-size:.95rem;margin:14px 0 6px}.eyebrow,.muted,.empty-state{color:var(--muted)}.eyebrow{font-weight:700;letter-spacing:.04em;margin-bottom:8px}.repository-line{font-weight:650}.metadata-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin:20px 0 0}.metadata-grid div{border-top:1px solid var(--line);padding-top:9px}.metadata-grid dt{font-size:.8rem;color:var(--muted)}.metadata-grid dd{margin:3px 0 0;overflow-wrap:anywhere}.report-section{scroll-margin-top:20px}.section-intro{max-width:80ch}.change-card,.option-card,.risk-card,.check-card,.impact-card,.checklist-item{border:1px solid var(--line);border-radius:12px;padding:16px;margin:12px 0;background:#fff}.before-after,.option-columns,.impact-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.before-after>div{border-left:3px solid #94a3b8;padding-left:12px}.before-after p{margin:0}.option-columns{grid-template-columns:repeat(3,minmax(0,1fr))}.impact-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.impact-card h3{font-size:.95rem}.impact-inferred{border-top:4px solid #b45309}.impact-unknown{border-top:4px solid #6b7280}.impact-proven{border-top:4px solid #15803d}.badge{display:inline-block;border-radius:999px;padding:2px 9px;font-size:.78rem;font-weight:750;line-height:1.5}.evidence-badge{background:#e0e7ff;color:#3730a3}.risk-badge{background:#fee2e2;color:var(--red)}.risk-low{background:#dcfce7;color:var(--green)}.risk-medium{background:#fef3c7;color:var(--amber)}.risk-unknown{background:#e5e7eb;color:#374151}.test-status.status-passed{background:#dcfce7;color:var(--green)}.test-status.status-failed{background:#fee2e2;color:var(--red)}.test-status.status-blocked{background:#ffedd5;color:var(--amber)}.test-status.status-not_run{background:#e5e7eb;color:#374151}.slack-status.status-available{background:#dbeafe;color:#1e40af}.slack-status.status-unavailable,.slack-status.status-not_found{background:#e5e7eb;color:#374151}.evidence-list,.slack-list{list-style:none;padding:0;margin:8px 0}.evidence-item{display:grid;grid-template-columns:auto minmax(100px,max-content) minmax(0,1fr) auto auto;gap:8px;align-items:start;padding:9px 0;border-top:1px solid #edf1f4}.evidence-item>span{overflow-wrap:anywhere}.evidence-path{color:var(--muted);font-size:.86rem}.source-link,.slack-list a{white-space:nowrap}.graph-scroll{overflow:auto;border:1px solid var(--line);border-radius:12px;background:#fbfdff;padding:8px}.flow-graph{display:block;width:100%;min-width:640px;height:auto}.flow-edge line{stroke:#64748b;stroke-width:2}.flow-edge marker path{fill:#64748b}.flow-edge text{font-size:13px;fill:#334155;paint-order:stroke;stroke:#fff;stroke-width:5px;stroke-linejoin:round}.flow-node rect{fill:#eff6ff;stroke:#2563eb;stroke-width:2}.flow-node text{font-size:15px;fill:#172554}.node-number{font-weight:750;fill:#1d4ed8}.graph-evidence{margin-top:14px;border:1px solid var(--line);border-radius:10px;padding:10px 14px}.graph-evidence summary{cursor:pointer;font-weight:700}.graph-evidence-group{margin-top:12px}.check-heading{display:flex;gap:12px;align-items:center;justify-content:space-between}.check-heading h3{margin:0}.check-card p{margin:8px 0}.slack-list li{display:flex;flex-wrap:wrap;gap:12px;align-items:center;border-top:1px solid var(--line);padding:10px 0}.slack-list li span{flex:1 1 260px}.slack-list time{color:var(--muted);font-size:.85rem}.human-checklist{padding-left:24px}.checklist-item{padding:14px 16px;margin:10px 0}.checklist-item h3{margin:0}.checklist-item p{margin:7px 0 0;color:var(--muted)}code{font-size:.9em;overflow-wrap:anywhere}a{color:#1d4ed8;text-underline-offset:3px}a:focus-visible,summary:focus-visible{outline:3px solid #60a5fa;outline-offset:3px}.report-footer{color:var(--muted);text-align:center;font-size:.9rem;padding:8px 16px}
@media(max-width:760px){main{width:min(100% - 20px,1120px);margin:12px auto 32px}.report-header,.report-section{padding:17px;border-radius:12px}.before-after,.option-columns,.impact-grid{grid-template-columns:1fr}.evidence-item{grid-template-columns:auto minmax(0,1fr)}.evidence-item>span:nth-of-type(2){grid-column:2}.evidence-path,.source-link{grid-column:2}.check-heading{align-items:flex-start;flex-direction:column}.metadata-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
.before-after pre{margin:0;min-height:2.4rem;white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.finding-card,.runner-stage{border:1px solid var(--line);border-radius:10px;padding:14px;margin:10px 0;background:#fff}.finding-location,.finding-thread{display:block;margin:4px 0;color:var(--muted)}.finding-body{white-space:pre-wrap;overflow-wrap:anywhere}.severity-badge{background:#fef3c7;color:#713f12}.confidence-badge{background:#e0e7ff;color:#3730a3}.runner-stages{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.runner-card>p{overflow-wrap:anywhere}
@media(max-width:760px){.runner-stages{grid-template-columns:1fr}}
.runner-output{white-space:pre-wrap;overflow-wrap:anywhere}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important}}
`;

export function renderReviewReportHtml(input: unknown): string {
  const report = normalizeReviewReport(input);
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(report.metadata.title)} · 사람 검토 메모</title><style>${CSS}</style></head><body><main>${renderMetadata(report)}${renderExecutiveSummary(report)}${renderChangeSummary(report)}${renderReviewFindings(report)}<section class="report-section"><h2>정적 코드 흐름</h2>${renderFlowGraph(report.flowGraph)}${renderGraphEvidence(report)}</section>${renderDecisionOptions(report)}${renderImpactScope(report)}${renderRisks(report)}${renderChecks(report)}${renderSlack(report)}${renderChecklist(report)}<footer class="report-footer">이 자료는 근거와 불확실성을 정리하며, 결정은 담당자가 내립니다.</footer></main></body></html>`;
}
