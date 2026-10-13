export interface PRDetails {
  number: number;
  title: string;
  body: string | null;
  state: string;
  author: { login: string };
  url: string;
  headRefName: string;
  baseRefName: string;
  createdAt: string;
  updatedAt: string;
  labels: unknown[];
  milestone: unknown | null;
  reviewRequests: Array<{ requestedReviewer: { login: string } }>;
  reviews: unknown[];
}

export interface InlineComment {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
}

export interface ReviewComment {
  id: number;
  body: string;
  user: { login: string } | null;
  path?: string | null;
  line?: number | null;
  original_line?: number | null;
  diff_hunk?: string | null;
  html_url?: string;
  in_reply_to_id?: number;
  created_at?: string;
  updated_at?: string;
}

export interface ReviewThreadComment {
  id: number;
  body: string;
  user: { login: string } | null;
  createdAt: string;
  updatedAt: string;
  url: string;
  inReplyToId: number | null;
}

export interface ReviewThread {
  id: string;
  rootCommentId: number;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  comments: ReviewThreadComment[];
}

export type RepositoryPermission = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none';

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

export interface ReviewRequester {
  login: string;
}
