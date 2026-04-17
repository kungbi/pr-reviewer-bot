export type PRStatus =
  | 'reviewing'
  | 'reviewed'
  | 'completed'
  | 'skipped'
  | 'pending_retry'
  | 'needs_reply'
  | 'pending_review'
  | 'blocked'
  | 'needs_work'
  | 'approved'
  | 'error';

export interface PRStateEntry {
  owner: string;
  repo: string;
  prNumber: number;
  status: PRStatus;
  headSha?: string | null;
  reviewedAt?: string;
  reviewingAt?: string;
  retryCount?: number;
  failures?: Array<{ timestamp: string; error: string }>;
  lastFailedAt?: string;
}

export interface StateFile {
  reviewedPRs: Record<string, PRStateEntry>;
  repliedComments: Record<string, { commentedAt: string }>;
}

export interface CommentReplyEntry {
  commentedAt: string;
}
