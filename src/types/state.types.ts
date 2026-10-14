import type { InlineComment, ReviewEvent } from './github.types';

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
  capacityRetryCount?: number;
  lastCapacityAt?: string;
  lastCapacityError?: string;
}

export interface StateFile {
  reviewedPRs: Record<string, PRStateEntry>;
  repliedComments: Record<string, { commentedAt: string }>;
  closedReviewThreads?: Record<string, ReviewThreadClosure>;
  pendingReviewReplies?: Record<string, ReviewReplyDelivery>;
  reviewPublications?: Record<string, ReviewPublication>;
  replyMonitorStartedAt?: string;
}

export type ReviewPublicationStatus = 'pending' | 'delivery_unknown' | 'completed';

export interface ReviewPublication {
  createdAt: string;
  status: ReviewPublicationStatus;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  botLogin: string;
  pendingBody?: string;
  pendingEvent?: ReviewEvent;
  pendingComments?: InlineComment[];
  operationMarker: string;
  postAttempted: boolean;
  completedAt?: string;
  reviewId?: number;
}

export type NewReviewPublication = Omit<
  ReviewPublication,
  'createdAt' | 'status' | 'postAttempted' | 'completedAt' | 'reviewId'
>;

export interface CommentReplyEntry {
  commentedAt: string;
}

export type ReviewThreadResolution =
  | 'human_handoff'
  | 'reconsideration_pending'
  | 'reconsideration_delivery_unknown'
  | 'reconsidered_merge_boundary';

export interface ReviewThreadClosure {
  closedAt: string;
  resolution: ReviewThreadResolution;
  handledCommentId?: string;
  handledCommentLogin?: string;
  pendingReplyBody?: string;
  pendingHeadSha?: string;
  operationMarker?: string;
  postAttempted?: boolean;
}

export type ReviewReplyDeliveryResolution = 'pending' | 'delivery_unknown';

export interface ReviewReplyDelivery {
  createdAt: string;
  resolution: ReviewReplyDeliveryResolution;
  humanReplyId: string;
  parentCommentId: number;
  pendingReplyBody: string;
  pendingHeadSha: string;
  operationMarker: string;
  postAttempted: boolean;
}
