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

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

export interface ReviewRequester {
  login: string;
}
