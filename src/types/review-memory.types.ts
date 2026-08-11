export type ReviewLessonCategory =
  | 'accepted'
  | 'false_positive'
  | 'project_convention'
  | 'one_off_exception'
  | 'needs_human_judgment'
  | 'unresolved';

export type ReviewLessonStatus = 'active' | 'archived' | 'rejected';

export interface ReviewMemorySource {
  owner: string;
  repo: string;
  prNumber: number;
  parentCommentId: number;
  humanReplyId: number;
  parentCommentUrl?: string;
  humanReplyUrl?: string;
  path?: string | null;
  line?: number | null;
  createdAt: string;
}

export interface ReviewThreadArchiveEntry {
  id: string;
  owner: string;
  repo: string;
  prNumber: number;
  parentCommentId: number;
  humanReplyId: number;
  parentCommentBody: string;
  humanReplyBody: string;
  botReplyBody?: string;
  path?: string | null;
  line?: number | null;
  diffHunk?: string | null;
  parentCommentUrl?: string;
  humanReplyUrl?: string;
  botReplyUrl?: string;
  classification?: ReviewLessonCategory;
  classifierReason?: string;
  confidence?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewLesson {
  id: string;
  owner: string;
  repo: string;
  status: ReviewLessonStatus;
  category: ReviewLessonCategory;
  confidence: number;
  title: string;
  lesson: string;
  whenToApply: string[];
  doNotApply: string[];
  pathGlobs?: string[];
  tags?: string[];
  source: ReviewMemorySource;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewMemoryFile {
  version: 1;
  threads: Record<string, ReviewThreadArchiveEntry>;
  lessons: Record<string, ReviewLesson>;
}

export interface OrganizationReviewWiki {
  owner: string;
  sourcePath: string;
  content: string;
}

export interface ReviewMemoryContext {
  lessons: ReviewLesson[];
  organizationWiki?: OrganizationReviewWiki;
}

export interface ReviewMemoryQuery {
  owner: string;
  repo: string;
  pathHints?: string[];
  limit?: number;
}
