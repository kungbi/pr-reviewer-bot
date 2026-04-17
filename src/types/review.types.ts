export type ReviewVerdict =
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
  owner: string;
  repo: string;
  prNumber: number;
  title: string;
}
