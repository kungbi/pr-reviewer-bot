export const REVIEW_REPORT_SCHEMA_VERSION = 1 as const;

export type ReviewEvidenceKind = 'diff' | 'code' | 'test' | 'ci' | 'slack' | 'analysis' | 'other';

export interface ReviewEvidence {
  kind: ReviewEvidenceKind;
  label: string;
  detail: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  side?: 'LEFT' | 'RIGHT';
  url?: string;
}

export interface ReviewReportMetadata {
  owner: string;
  repository: string;
  pullRequestNumber: number;
  title: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  generatedAt: string;
}

export interface ReviewChange {
  title: string;
  nonTextual?: 'binary' | 'mode' | 'rename';
  before?: string;
  after?: string;
  evidence: ReviewEvidence[];
}

export type ReviewFindingSource = 'inline_comment' | 'thread_reply' | 'existing_thread';
export type ReviewFindingStatus =
  | 'finding'
  | 'proposal'
  | 'reply'
  | 'still_applies'
  | 'fixed_in_code'
  | 'not_actionable'
  | 'uncertain';
export type ReviewFindingSeverity = 'blocker' | 'important' | 'minor' | 'unknown';
export type ReviewFindingConfidence = 'confirmed' | 'uncertain' | 'not_recorded';

/** Verified review narrative, kept distinct from the report's human decision. */
export interface ReviewFinding {
  source: ReviewFindingSource;
  status: ReviewFindingStatus;
  severity: ReviewFindingSeverity;
  confidence: ReviewFindingConfidence;
  uncertaintyReason?: string;
  body: string;
  path?: string;
  line?: number;
  side?: 'LEFT' | 'RIGHT';
  threadId?: number;
}

export interface ReviewFlowNode {
  id: string;
  label: string;
  evidence: ReviewEvidence[];
}

export interface ReviewFlowEdge {
  from: string;
  to: string;
  label: string;
  evidence: ReviewEvidence[];
}

export type ReviewFlowGraphStatus = 'available' | 'unavailable' | 'not_applicable';

export interface ReviewFlowGraph {
  status: ReviewFlowGraphStatus;
  nodes: ReviewFlowNode[];
  edges: ReviewFlowEdge[];
  note?: string;
}

export type ReviewDecisionSource = 'slack_team_discussion' | 'analysis_proposal';
export type ReviewDecisionStatus = 'decision' | 'proposal' | 'rejected' | 'unresolved';

export interface ReviewDecisionOption {
  id: string;
  title: string;
  source: ReviewDecisionSource;
  status: ReviewDecisionStatus;
  description?: string;
  benefits: string[];
  drawbacks: string[];
  assumptions: string[];
  provenance: ReviewEvidence[];
  convention?: string;
  scope?: 'current_pr' | 'follow_up';
}

export interface ReviewImpactScope {
  proven: string[];
  inferred: string[];
  unknown: string[];
}

export type ReviewRiskLevel = 'low' | 'medium' | 'high' | 'critical' | 'unknown';

export interface ReviewRisk {
  level: ReviewRiskLevel;
  title: string;
  rationale: string;
  mitigations: string[];
}

export interface ReviewExecutiveSummary {
  conclusion: string;
  requiredDecisions: string[];
  overallRisk: ReviewRisk;
}

export type ReviewCheckStatus = 'passed' | 'failed' | 'blocked' | 'not_run';

export interface ReviewCheck {
  name: string;
  status: ReviewCheckStatus;
  details: string;
  evidence: ReviewEvidence[];
}

export interface ReviewTestRunnerStage {
  status: ReviewCheckStatus;
  reason: string;
  exitCode?: number;
  output?: string;
  stdout?: string;
  stderr?: string;
}

export interface ReviewTestRunner {
  runtime?: string;
  selectedCommand?: string;
  status: ReviewCheckStatus;
  reason: string;
  install: ReviewTestRunnerStage;
  test: ReviewTestRunnerStage;
}

export type SlackReviewStatus = 'available' | 'unavailable' | 'not_found';

export interface SlackReviewItem {
  summary: string;
  permalink: string;
  author?: string;
  timestamp?: string;
}

export interface SlackReviewContext {
  status: SlackReviewStatus;
  items: SlackReviewItem[];
  note?: string;
}

export interface HumanChecklistItem {
  id: string;
  question: string;
  rationale?: string;
}

export interface ReviewReport {
  schemaVersion: typeof REVIEW_REPORT_SCHEMA_VERSION;
  executiveSummary: ReviewExecutiveSummary;
  metadata: ReviewReportMetadata;
  changeSummary: {
    overview: string;
    changes: ReviewChange[];
  };
  flowGraph: ReviewFlowGraph;
  decisionOptions: ReviewDecisionOption[];
  impactScope: ReviewImpactScope;
  risks: ReviewRisk[];
  checks: ReviewCheck[];
  reviewFindings?: ReviewFinding[];
  reviewFindingsOmitted?: number;
  changeHunksOmitted?: number;
  decisionOptionsOmitted?: number;
  testRunner?: ReviewTestRunner;
  slack: SlackReviewContext;
  humanChecklist: HumanChecklistItem[];
}
