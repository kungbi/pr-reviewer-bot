export type ReviewVerdict =
  | 'awaiting_human_review'
  | 'reviewed'
  | 'blocked'
  | 'needs_work'
  | 'approved'
  | 'already_reviewed'
  | 'error';

export interface ReviewResult {
  success: boolean;
  verdict: ReviewVerdict;
  commentPosted: boolean;
  error?: string;
  timingMs?: { total: number };
}

export interface FileLineRef {
  file: string;
  line: number;
  severity: Severity;
  context: string;
}

export type Severity = 'blocker' | 'important' | 'minor';

export interface RetryOutcome {
  success: boolean;
  skipped: boolean;
  retryCount: number;
  result?: ReviewResult;
  error?: string;
}

export interface PRInfo {
  headSha?: string | null;
  owner: string;
  repo: string;
  prNumber: number;
  title: string;
}
