import {
  REVIEW_REPORT_SCHEMA_VERSION,
  type HumanChecklistItem,
  type ReviewChange,
  type ReviewCheck,
  type ReviewCheckStatus,
  type ReviewDecisionOption,
  type ReviewDecisionSource,
  type ReviewDecisionStatus,
  type ReviewEvidence,
  type ReviewFinding,
  type ReviewFindingConfidence,
  type ReviewFindingSeverity,
  type ReviewFindingSource,
  type ReviewFindingStatus,
  type ReviewFlowEdge,
  type ReviewFlowGraphStatus,
  type ReviewFlowNode,
  type ReviewImpactScope,
  type ReviewReport,
  type ReviewReportMetadata,
  type ReviewRisk,
  type ReviewRiskLevel,
  type ReviewExecutiveSummary,
  type ReviewTestRunner,
  type SlackReviewContext,
  type SlackReviewItem,
} from '../types/review-report.types';

const LIMITS = {
  shortText: 240,
  text: 2_000,
  detail: 1_200,
  path: 500,
  url: 2_048,
  generalArray: 20,
  evidence: 8,
  changes: 30,
  options: 30,
  reviewFindings: 120,
  graphNodes: 30,
  graphEdges: 60,
  checks: 40,
  slackItems: 20,
  checklist: 20,
} as const;

const EVIDENCE_KINDS = ['diff', 'code', 'test', 'ci', 'slack', 'analysis', 'other'] as const;
const CHECK_STATUSES: readonly ReviewCheckStatus[] = ['passed', 'failed', 'blocked', 'not_run'];
const RISK_LEVELS: readonly ReviewRiskLevel[] = ['low', 'medium', 'high', 'critical', 'unknown'];
const FLOW_GRAPH_STATUSES: readonly ReviewFlowGraphStatus[] = ['available', 'unavailable', 'not_applicable'];
const DECISION_SOURCES: readonly ReviewDecisionSource[] = ['slack_team_discussion', 'analysis_proposal'];
const DECISION_STATUSES: readonly ReviewDecisionStatus[] = ['decision', 'proposal', 'rejected', 'unresolved'];
const SLACK_STATUSES: readonly SlackReviewContext['status'][] = ['available', 'unavailable', 'not_found'];
const REVIEW_FINDING_SOURCES: readonly ReviewFindingSource[] = ['inline_comment', 'thread_reply', 'existing_thread'];
const REVIEW_FINDING_STATUSES: readonly ReviewFindingStatus[] = [
  'finding', 'proposal', 'reply', 'still_applies', 'fixed_in_code', 'not_actionable', 'uncertain',
];
const REVIEW_FINDING_SEVERITIES: readonly ReviewFindingSeverity[] = ['blocker', 'important', 'minor', 'unknown'];
const REVIEW_FINDING_CONFIDENCES: readonly ReviewFindingConfidence[] = ['confirmed', 'uncertain', 'not_recorded'];
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function fail(path: string, reason: string): never {
  throw new Error(`invalid review report: ${path} ${reason}`);
}

function object(value: unknown, path: string, required: string[], optional: string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(path, 'must be an object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(path, 'must be a plain object');
  }
  const record = value as Record<string, unknown>;
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      fail(`${path}.${key}`, 'is required');
    }
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, 'is not allowed');
  }
  return record;
}

function text(value: unknown, path: string, maxLength: number = LIMITS.text): string {
  if (typeof value !== 'string') return fail(path, 'must be a string');
  const normalized = value.trim();
  if (normalized.length === 0) return fail(path, 'must not be empty');
  if (normalized.length > maxLength) return fail(path, `must be at most ${maxLength} characters`);
  if (CONTROL_CHARACTERS.test(normalized)) return fail(path, 'contains a control character');
  return normalized;
}

function optionalText(record: Record<string, unknown>, key: string, path: string, maxLength: number = LIMITS.text): string | undefined {
  if (record[key] === undefined) return undefined;
  return text(record[key], `${path}.${key}`, maxLength);
}

function changeSnippet(value: unknown, path: string): string {
  if (typeof value !== 'string') return fail(path, 'must be a string when present');
  if (value.length > LIMITS.text) return fail(path, `must be at most ${LIMITS.text} characters`);
  if (CONTROL_CHARACTERS.test(value)) return fail(path, 'contains a control character');
  return value;
}

function list<T>(
  value: unknown,
  path: string,
  maxItems: number,
  parseItem: (item: unknown, itemPath: string) => T,
  minItems = 0,
): T[] {
  if (!Array.isArray(value)) return fail(path, 'must be an array');
  if (value.length < minItems || value.length > maxItems) {
    return fail(path, `must contain between ${minItems} and ${maxItems} items`);
  }
  return value.map((item, index) => parseItem(item, `${path}[${index}]`));
}

function stringList(value: unknown, path: string, minItems = 0): string[] {
  return list(value, path, LIMITS.generalArray, (item, itemPath) => text(item, itemPath), minItems);
}

function lineNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return fail(path, 'must be a positive safe integer');
  }
  return value;
}

function omittedCount(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return fail(path, 'must be a positive safe integer when present');
  }
  return value;
}

function parseIsoTimestamp(value: string, path: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) fail(path, 'must be an ISO-8601 timestamp');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) {
    fail(path, 'must contain a valid calendar date');
  }
  if (hour > 23 || minute > 59 || second > 59) fail(path, 'must contain a valid time');
  if (match[9] !== undefined && (Number(match[10]) > 23 || Number(match[11]) > 59)) {
    fail(path, 'must contain a valid timezone offset');
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(path, 'must be a valid timestamp');
  return parsed;
}

function allowedGitHubUrl(value: string): boolean {
  if (!/^https:\/\/github\.com(?:\/|\?|#|$)/i.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.hostname.toLowerCase() === 'github.com'
      && parsed.username === ''
      && parsed.password === ''
      && parsed.port === '';
  } catch {
    return false;
  }
}

function allowedSlackPermalink(value: string): boolean {
  if (!/^https:\/\/(?:app|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.slack\.com(?:\/|\?|#|$)/i.test(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === 'https:'
      && /^(?:app|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.slack\.com$/.test(host)
      && parsed.username === ''
      && parsed.password === ''
      && parsed.port === ''
      && parsed.pathname.length > 1;
  } catch {
    return false;
  }
}

function evidence(value: unknown, path: string): ReviewEvidence {
  const record = object(value, path, ['kind', 'label', 'detail'], ['path', 'startLine', 'endLine', 'side', 'url']);
  if (!EVIDENCE_KINDS.includes(record.kind as (typeof EVIDENCE_KINDS)[number])) {
    fail(`${path}.kind`, 'is invalid');
  }
  const result: ReviewEvidence = {
    kind: record.kind as ReviewEvidence['kind'],
    label: text(record.label, `${path}.label`, LIMITS.shortText),
    detail: text(record.detail, `${path}.detail`, LIMITS.detail),
  };
  const sourcePath = optionalText(record, 'path', path, LIMITS.path);
  if (sourcePath !== undefined) {
    if (sourcePath.startsWith('/') || sourcePath.includes('\\') || sourcePath.split('/').some((part) => part === '..')) {
      fail(`${path}.path`, 'must be a repository-relative path');
    }
    result.path = sourcePath;
  }
  const startLine = record.startLine === undefined ? undefined : lineNumber(record.startLine, `${path}.startLine`);
  const endLine = record.endLine === undefined ? undefined : lineNumber(record.endLine, `${path}.endLine`);
  if (endLine !== undefined && (startLine === undefined || endLine < startLine)) {
    fail(path, 'has an invalid evidence line range');
  }
  if (startLine !== undefined) result.startLine = startLine;
  if (endLine !== undefined) result.endLine = endLine;
  if (record.side !== undefined) {
    if (record.side !== 'LEFT' && record.side !== 'RIGHT') fail(`${path}.side`, 'must be LEFT or RIGHT');
    result.side = record.side;
  }
  const sourceUrl = optionalText(record, 'url', path, LIMITS.url);
  if (result.kind === 'slack' && (sourceUrl === undefined || !allowedSlackPermalink(sourceUrl))) {
    fail(`${path}.url`, 'is required for Slack evidence and must be a valid workspace permalink');
  }
  if (sourceUrl !== undefined) {
    if (!allowedGitHubUrl(sourceUrl) && !allowedSlackPermalink(sourceUrl)) {
      fail(`${path}.url`, 'must be a valid GitHub or Slack https URL');
    }
    result.url = sourceUrl;
  }
  return result;
}

function evidenceList(value: unknown, path: string, minItems = 0): ReviewEvidence[] {
  return list(value, path, LIMITS.evidence, evidence, minItems);
}

export function validateReviewReportMetadata(value: unknown): ReviewReportMetadata {
  const path = 'metadata';
  const record = object(value, path, [
    'owner', 'repository', 'pullRequestNumber', 'title', 'baseRef', 'baseSha', 'headRef', 'headSha', 'generatedAt',
  ]);
  const owner = text(record.owner, `${path}.owner`, 100);
  const repository = text(record.repository, `${path}.repository`, 100);
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || owner === '.' || owner === '..') fail(`${path}.owner`, 'is not a valid GitHub owner');
  if (!/^[A-Za-z0-9_.-]+$/.test(repository) || repository === '.' || repository === '..') fail(`${path}.repository`, 'is not a valid GitHub repository');
  if (typeof record.pullRequestNumber !== 'number' || !Number.isSafeInteger(record.pullRequestNumber) || record.pullRequestNumber < 1) {
    fail(`${path}.pullRequestNumber`, 'must be a positive safe integer');
  }
  const baseSha = text(record.baseSha, `${path}.baseSha`, 64);
  const headSha = text(record.headSha, `${path}.headSha`, 64);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(baseSha)) fail(`${path}.baseSha`, 'must be a full hexadecimal commit SHA');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(headSha)) fail(`${path}.headSha`, 'must be a full hexadecimal commit SHA');
  const generatedAt = text(record.generatedAt, `${path}.generatedAt`, 40);
  const parsedTime = parseIsoTimestamp(generatedAt, `${path}.generatedAt`);
  return {
    owner,
    repository,
    pullRequestNumber: record.pullRequestNumber,
    title: text(record.title, `${path}.title`, LIMITS.shortText),
    baseRef: text(record.baseRef, `${path}.baseRef`, LIMITS.shortText),
    baseSha: baseSha.toLowerCase(),
    headRef: text(record.headRef, `${path}.headRef`, LIMITS.shortText),
    headSha: headSha.toLowerCase(),
    generatedAt: new Date(parsedTime).toISOString(),
  };
}

function change(value: unknown, path: string): ReviewChange {
  const record = object(value, path, ['title', 'evidence'], ['before', 'after', 'nonTextual']);
  const before = record.before === undefined ? undefined : changeSnippet(record.before, `${path}.before`);
  const after = record.after === undefined ? undefined : changeSnippet(record.after, `${path}.after`);
  const nonTextual = record.nonTextual;
  if (nonTextual !== undefined && nonTextual !== 'binary' && nonTextual !== 'mode' && nonTextual !== 'rename') fail(path, 'invalid non-textual change');
  if (nonTextual === undefined && before === undefined && after === undefined) fail(path, 'must include at least one actual changed side');
  if (nonTextual !== undefined && (before !== undefined || after !== undefined)) fail(path, 'non-textual change cannot include changed sides');
  const evidence = evidenceList(record.evidence, `${path}.evidence`, 1);
  if (nonTextual !== undefined && !evidence.some((item) => item.kind === 'diff' && item.path !== undefined)) fail(path, 'non-textual change requires diff path evidence');
  return {
    title: text(record.title, `${path}.title`, LIMITS.shortText),
    ...(nonTextual === undefined ? {} : { nonTextual }),
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
    evidence,
  };
}

function flowNode(value: unknown, path: string): ReviewFlowNode {
  const record = object(value, path, ['id', 'label', 'evidence']);
  const id = text(record.id, `${path}.id`, 64);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) fail(`${path}.id`, 'must contain only letters, numbers, underscores, and hyphens');
  return {
    id,
    label: text(record.label, `${path}.label`, LIMITS.shortText),
    evidence: evidenceList(record.evidence, `${path}.evidence`, 1),
  };
}

function flowEdge(value: unknown, path: string): ReviewFlowEdge {
  const record = object(value, path, ['from', 'to', 'label', 'evidence']);
  const endpoint = (item: unknown, field: string) => {
    const id = text(item, `${path}.${field}`, 64);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) fail(`${path}.${field}`, 'is not a valid node ID');
    return id;
  };
  return {
    from: endpoint(record.from, 'from'),
    to: endpoint(record.to, 'to'),
    label: text(record.label, `${path}.label`, LIMITS.shortText),
    evidence: evidenceList(record.evidence, `${path}.evidence`, 1),
  };
}

function flowGraph(value: unknown): ReviewReport['flowGraph'] {
  const record = object(value, 'flowGraph', ['status', 'nodes', 'edges'], ['note']);
  if (!FLOW_GRAPH_STATUSES.includes(record.status as ReviewFlowGraphStatus)) fail('flowGraph.status', 'is invalid');
  const status = record.status as ReviewFlowGraphStatus;
  const nodes = list(record.nodes, 'flowGraph.nodes', LIMITS.graphNodes, flowNode);
  const edges = list(record.edges, 'flowGraph.edges', LIMITS.graphEdges, flowEdge);
  const note = optionalText(record, 'note', 'flowGraph', LIMITS.detail);
  if (status === 'available' && (nodes.length < 2 || edges.length < 1)) {
    fail('flowGraph', 'must include at least two evidence-backed nodes and one evidence-backed edge when available');
  }
  if (status !== 'available' && (nodes.length > 0 || edges.length > 0)) {
    fail('flowGraph', 'must not include nodes or edges when unavailable or not applicable');
  }
  if (status !== 'available' && note === undefined) {
    fail('flowGraph.note', 'is required when the graph is unavailable or not applicable');
  }
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (nodeIds.has(node.id)) fail('flowGraph.nodes', `duplicate flow graph node id "${node.id}"`);
    nodeIds.add(node.id);
  }
  for (const edge of edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      fail('flowGraph.edges', `dangling flow graph edge "${edge.from}" -> "${edge.to}"`);
    }
  }
  return note === undefined ? { status, nodes, edges } : { status, nodes, edges, note };
}

function decisionOption(value: unknown, path: string): ReviewDecisionOption {
  const record = object(value, path, [
    'id', 'title', 'source', 'status', 'benefits', 'drawbacks', 'assumptions', 'provenance',
  ], ['description', 'convention', 'scope']);
  const id = text(record.id, `${path}.id`, 64);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) fail(`${path}.id`, 'must contain only letters, numbers, underscores, and hyphens');
  if (!DECISION_SOURCES.includes(record.source as ReviewDecisionSource)) fail(`${path}.source`, 'is invalid');
  if (!DECISION_STATUSES.includes(record.status as ReviewDecisionStatus)) fail(`${path}.status`, 'is invalid');
  const source = record.source as ReviewDecisionSource;
  const status = record.status as ReviewDecisionStatus;
  if (source === 'analysis_proposal' && status !== 'proposal' && status !== 'unresolved') {
    fail(`${path}.status`, 'analysis cannot assert a confirmed or rejected team decision');
  }
  const provenance = evidenceList(record.provenance, `${path}.provenance`, 1);
  if (source === 'slack_team_discussion' && !provenance.some((item) => item.kind === 'slack')) {
    fail(`${path}.provenance`, 'must cite Slack evidence for a Slack team discussion');
  }
  if (source === 'analysis_proposal' && provenance.every((item) => item.kind === 'slack')) {
    fail(`${path}.provenance`, 'must cite non-Slack evidence for an analysis proposal');
  }
  const result: ReviewDecisionOption = {
    id,
    title: text(record.title, `${path}.title`, LIMITS.shortText),
    source,
    status,
    benefits: stringList(record.benefits, `${path}.benefits`, 1),
    drawbacks: stringList(record.drawbacks, `${path}.drawbacks`, 1),
    assumptions: stringList(record.assumptions, `${path}.assumptions`, source === 'analysis_proposal' ? 0 : 1),
    provenance,
  };
  const description = optionalText(record, 'description', path);
  if (description !== undefined) result.description = description;
  const convention = optionalText(record, 'convention', path);
  if (convention !== undefined) result.convention = convention;
  const scope = record.scope;
  if (scope !== undefined) {
    if (scope !== 'current_pr' && scope !== 'follow_up') fail(`${path}.scope`, 'is invalid');
    result.scope = scope;
  }
  return result;
}

function impactScope(value: unknown): ReviewImpactScope {
  const record = object(value, 'impactScope', ['proven', 'inferred', 'unknown']);
  return {
    proven: stringList(record.proven, 'impactScope.proven'),
    inferred: stringList(record.inferred, 'impactScope.inferred'),
    unknown: stringList(record.unknown, 'impactScope.unknown'),
  };
}

function risk(value: unknown, path: string, minMitigations = 0): ReviewRisk {
  const record = object(value, path, ['level', 'title', 'rationale', 'mitigations']);
  if (!RISK_LEVELS.includes(record.level as ReviewRiskLevel)) fail(`${path}.level`, 'is invalid');
  return {
    level: record.level as ReviewRiskLevel,
    title: text(record.title, `${path}.title`, LIMITS.shortText),
    rationale: text(record.rationale, `${path}.rationale`),
    mitigations: stringList(record.mitigations, `${path}.mitigations`, minMitigations),
  };
}

function executiveSummary(value: unknown): ReviewExecutiveSummary {
  const path = 'executiveSummary';
  const record = object(value, path, ['conclusion', 'requiredDecisions', 'overallRisk']);
  return {
    conclusion: text(record.conclusion, `${path}.conclusion`),
    requiredDecisions: stringList(record.requiredDecisions, `${path}.requiredDecisions`, 1),
    overallRisk: risk(record.overallRisk, `${path}.overallRisk`, 1),
  };
}

function check(value: unknown, path: string): ReviewCheck {
  const record = object(value, path, ['name', 'status', 'details', 'evidence']);
  if (!CHECK_STATUSES.includes(record.status as ReviewCheckStatus)) fail(`${path}.status`, 'is invalid');
  return {
    name: text(record.name, `${path}.name`, LIMITS.shortText),
    status: record.status as ReviewCheckStatus,
    details: text(record.details, `${path}.details`),
    evidence: evidenceList(record.evidence, `${path}.evidence`),
  };
}

function reviewFinding(value: unknown, path: string): ReviewFinding {
  const record = object(value, path, ['source', 'status', 'severity', 'confidence', 'body'], [
    'path', 'line', 'side', 'threadId', 'uncertaintyReason',
  ]);
  if (!REVIEW_FINDING_SOURCES.includes(record.source as ReviewFindingSource)) fail(`${path}.source`, 'is invalid');
  if (!REVIEW_FINDING_STATUSES.includes(record.status as ReviewFindingStatus)) fail(`${path}.status`, 'is invalid');
  if (!REVIEW_FINDING_SEVERITIES.includes(record.severity as ReviewFindingSeverity)) fail(`${path}.severity`, 'is invalid');
  if (!REVIEW_FINDING_CONFIDENCES.includes(record.confidence as ReviewFindingConfidence)) fail(`${path}.confidence`, 'is invalid');

  const source = record.source as ReviewFindingSource;
  const status = record.status as ReviewFindingStatus;
  const result: ReviewFinding = {
    source,
    status,
    severity: record.severity as ReviewFindingSeverity,
    confidence: record.confidence as ReviewFindingConfidence,
    body: text(record.body, `${path}.body`),
  };
  if (record.uncertaintyReason !== undefined) {
    text(record.uncertaintyReason, `${path}.uncertaintyReason`);
    result.uncertaintyReason = record.uncertaintyReason as string;
  }
  const sourcePath = optionalText(record, 'path', path, LIMITS.path);
  if (sourcePath !== undefined) {
    if (sourcePath.startsWith('/') || sourcePath.includes('\\') || sourcePath.split('/').some((part) => part === '..' || part === '.')) {
      fail(`${path}.path`, 'must be a repository-relative path');
    }
    result.path = sourcePath;
  }
  const sourceLine = record.line === undefined ? undefined : lineNumber(record.line, `${path}.line`);
  if (sourceLine !== undefined) result.line = sourceLine;
  if (record.side !== undefined) {
    if (record.side !== 'LEFT' && record.side !== 'RIGHT') fail(`${path}.side`, 'must be LEFT or RIGHT');
    result.side = record.side;
  }
  const threadId = record.threadId;
  if (threadId !== undefined) {
    if (typeof threadId !== 'number' || !Number.isSafeInteger(threadId) || threadId < 1) {
      fail(`${path}.threadId`, 'must be a positive safe integer');
    }
    result.threadId = threadId;
  }

  if (source === 'inline_comment' && (sourcePath === undefined || sourceLine === undefined || result.side === undefined)) {
    fail(path, 'inline comments require path, line, and side provenance');
  }
  if (source === 'inline_comment' && status !== 'finding' && status !== 'proposal') {
    fail(`${path}.status`, 'inline comments must be findings or proposals');
  }
  if (source === 'thread_reply' && (threadId === undefined || status !== 'reply')) {
    fail(path, 'thread replies require a thread ID and reply status');
  }
  if (source === 'existing_thread' && (threadId === undefined || status === 'finding' || status === 'proposal' || status === 'reply')) {
    fail(path, 'existing thread assessments require a thread ID and assessment status');
  }
  return result;
}

function testRunnerStage(value: unknown, path: string): ReviewTestRunner['install'] {
  const record = object(value, path, ['status', 'reason'], ['exitCode', 'output', 'stdout', 'stderr']);
  if (!CHECK_STATUSES.includes(record.status as ReviewCheckStatus)) fail(`${path}.status`, 'is invalid');
  if (record.exitCode !== undefined && (!Number.isSafeInteger(record.exitCode) || (record.exitCode as number) < 0)) fail(`${path}.exitCode`, 'must be a non-negative integer');
  const output = optionalText(record, 'output', path);
  const stdout = optionalText(record, 'stdout', path);
  const stderr = optionalText(record, 'stderr', path);
  return {
    status: record.status as ReviewCheckStatus,
    reason: text(record.reason, `${path}.reason`),
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode as number }),
    ...(output === undefined ? {} : { output }),
    ...(stdout === undefined ? {} : { stdout }),
    ...(stderr === undefined ? {} : { stderr }),
  };
}

function testRunner(value: unknown): ReviewTestRunner {
  const path = 'testRunner';
  const record = object(value, path, ['status', 'reason', 'install', 'test'], ['runtime', 'selectedCommand']);
  if (!CHECK_STATUSES.includes(record.status as ReviewCheckStatus)) fail(`${path}.status`, 'is invalid');
  const runtime = optionalText(record, 'runtime', path, LIMITS.shortText);
  const selectedCommand = optionalText(record, 'selectedCommand', path, LIMITS.shortText);
  return {
    ...(runtime === undefined ? {} : { runtime }),
    ...(selectedCommand === undefined ? {} : { selectedCommand }),
    status: record.status as ReviewCheckStatus,
    reason: text(record.reason, `${path}.reason`),
    install: testRunnerStage(record.install, `${path}.install`),
    test: testRunnerStage(record.test, `${path}.test`),
  };
}

function slackItem(value: unknown, path: string): SlackReviewItem {
  const record = object(value, path, ['summary', 'permalink'], ['author', 'timestamp']);
  const permalink = text(record.permalink, `${path}.permalink`, LIMITS.url);
  if (!allowedSlackPermalink(permalink)) fail(`${path}.permalink`, 'must be a valid Slack workspace permalink');
  const result: SlackReviewItem = {
    summary: text(record.summary, `${path}.summary`, LIMITS.detail),
    permalink,
  };
  const author = optionalText(record, 'author', path, LIMITS.shortText);
  if (author !== undefined) result.author = author;
  const timestamp = optionalText(record, 'timestamp', path, 40);
  if (timestamp !== undefined) {
    const timestampMs = parseIsoTimestamp(timestamp, `${path}.timestamp`);
    result.timestamp = new Date(timestampMs).toISOString();
  }
  return result;
}

function slackContext(value: unknown): SlackReviewContext {
  const record = object(value, 'slack', ['status', 'items'], ['note']);
  if (!SLACK_STATUSES.includes(record.status as SlackReviewContext['status'])) fail('slack.status', 'is invalid');
  const status = record.status as SlackReviewContext['status'];
  const items = list(record.items, 'slack.items', LIMITS.slackItems, slackItem);
  if (status === 'available' && items.length === 0) fail('slack.items', 'must include an item when status is available');
  if (status !== 'available' && items.length > 0) fail('slack.items', 'must be empty when Slack is unavailable or not found');
  const result: SlackReviewContext = { status, items };
  const note = optionalText(record, 'note', 'slack', LIMITS.detail);
  if (note !== undefined) result.note = note;
  return result;
}

function checklistItem(value: unknown, path: string): HumanChecklistItem {
  const record = object(value, path, ['id', 'question'], ['rationale']);
  const id = text(record.id, `${path}.id`, 64);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) fail(`${path}.id`, 'must contain only letters, numbers, underscores, and hyphens');
  const result: HumanChecklistItem = {
    id,
    question: text(record.question, `${path}.question`),
  };
  const rationale = optionalText(record, 'rationale', path);
  if (rationale !== undefined) result.rationale = rationale;
  return result;
}

function validateSlackEvidenceCrossReferences(report: ReviewReport): void {
  const evidenceGroups: Array<[string, ReviewEvidence[]]> = [
    ...report.changeSummary.changes.map((change) => ['change evidence', change.evidence] as [string, ReviewEvidence[]]),
    ...report.flowGraph.nodes.map((node) => ['graph node evidence', node.evidence] as [string, ReviewEvidence[]]),
    ...report.flowGraph.edges.map((edge) => ['graph edge evidence', edge.evidence] as [string, ReviewEvidence[]]),
    ...report.decisionOptions.map((option) => [
      option.source === 'analysis_proposal' ? 'analysis proposal provenance' : 'decision option provenance',
      option.provenance,
    ] as [string, ReviewEvidence[]]),
    ...report.checks.map((item) => ['check evidence', item.evidence] as [string, ReviewEvidence[]]),
  ];
  const availablePermalinks = new Set(report.slack.items.map((item) => item.permalink));

  for (const [label, evidenceItems] of evidenceGroups) {
    for (const item of evidenceItems) {
      if (item.kind !== 'slack') continue;
      if (report.slack.status !== 'available') {
        fail('report', 'Slack evidence requires an available matching permalink');
      }
      if (item.url === undefined || !availablePermalinks.has(item.url)) {
        fail('report', `unmatched Slack evidence in ${label}`);
      }
    }
  }
}

export function normalizeReviewReport(input: unknown): ReviewReport {
  const root = object(input, 'report', [
    'schemaVersion', 'executiveSummary', 'metadata', 'changeSummary', 'flowGraph', 'decisionOptions', 'impactScope',
    'risks', 'checks', 'slack', 'humanChecklist',
  ], ['reviewFindings', 'reviewFindingsOmitted', 'changeHunksOmitted', 'decisionOptionsOmitted', 'testRunner']);
  if (root.schemaVersion !== REVIEW_REPORT_SCHEMA_VERSION) fail('schemaVersion', 'is unsupported');

  const changeSummary = object(root.changeSummary, 'changeSummary', ['overview', 'changes']);
  const slack = slackContext(root.slack);
  const reviewFindings = root.reviewFindings === undefined
    ? []
    : list(root.reviewFindings, 'reviewFindings', LIMITS.reviewFindings, reviewFinding);
  const reviewFindingsOmitted = omittedCount(root.reviewFindingsOmitted, 'reviewFindingsOmitted');
  const changeHunksOmitted = omittedCount(root.changeHunksOmitted, 'changeHunksOmitted');
  const decisionOptionsOmitted = omittedCount(root.decisionOptionsOmitted, 'decisionOptionsOmitted');
  const isolatedRunner = root.testRunner === undefined ? undefined : testRunner(root.testRunner);
  const decisionOptions = list(root.decisionOptions, 'decisionOptions', LIMITS.options, decisionOption);
  const slackPermalinks = new Set(slack.items.map((item) => item.permalink));
  for (const option of decisionOptions) {
    if (option.source !== 'slack_team_discussion') continue;
    if (slack.status !== 'available') {
      fail('decisionOptions', 'cannot cite a Slack team decision when Slack context is unavailable or not found');
    }
    for (const citation of option.provenance.filter((item) => item.kind === 'slack')) {
      if (citation.url === undefined || !slackPermalinks.has(citation.url)) {
        fail('decisionOptions', 'Slack decision evidence must match an item in the available Slack context');
      }
    }
  }
  const optionIds = new Set<string>();
  for (const option of decisionOptions) {
    if (optionIds.has(option.id)) fail('decisionOptions', `duplicate decision option id "${option.id}"`);
    optionIds.add(option.id);
  }
  const humanChecklist = list(root.humanChecklist, 'humanChecklist', LIMITS.checklist, checklistItem, 1);
  const checklistIds = new Set<string>();
  for (const item of humanChecklist) {
    if (checklistIds.has(item.id)) fail('humanChecklist', `duplicate checklist id "${item.id}"`);
    checklistIds.add(item.id);
  }

  const report: ReviewReport = {
    schemaVersion: REVIEW_REPORT_SCHEMA_VERSION,
    executiveSummary: executiveSummary(root.executiveSummary),
    metadata: validateReviewReportMetadata(root.metadata),
    changeSummary: {
      overview: text(changeSummary.overview, 'changeSummary.overview'),
      changes: list(changeSummary.changes, 'changeSummary.changes', LIMITS.changes, change),
    },
    flowGraph: flowGraph(root.flowGraph),
    decisionOptions,
    impactScope: impactScope(root.impactScope),
    risks: list(root.risks, 'risks', LIMITS.generalArray, risk),
    checks: list(root.checks, 'checks', LIMITS.checks, check, 1),
    reviewFindings,
    ...(reviewFindingsOmitted === undefined ? {} : { reviewFindingsOmitted }),
    ...(changeHunksOmitted === undefined ? {} : { changeHunksOmitted }),
    ...(decisionOptionsOmitted === undefined ? {} : { decisionOptionsOmitted }),
    ...(isolatedRunner === undefined ? {} : { testRunner: isolatedRunner }),
    slack,
    humanChecklist,
  };
  validateSlackEvidenceCrossReferences(report);
  return report;
}
