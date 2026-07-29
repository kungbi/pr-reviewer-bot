import { InlineComment, ReviewEvent } from '../types';
import { prepareReviewForPosting, ReviewDraft } from './review-draft';

export interface PublishVerifiedDraftArgs {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  draft: ReviewDraft;
  postInlineReview: (
    owner: string,
    repo: string,
    prNumber: number,
    headSha: string,
    body: string,
    event: ReviewEvent,
    comments: InlineComment[],
  ) => Promise<unknown>;
  postReviewCommentReply: (
    owner: string,
    repo: string,
    prNumber: number,
    commentId: number,
    body: string,
  ) => Promise<unknown>;
}

/**
 * The only write boundary for AI-generated PR review text.
 * Callers must supply the output of the independent verification pass, never
 * the first-pass draft. Authorship disclosure and event derivation are applied
 * here rather than delegated to the agent prompt.
 */
export async function publishVerifiedDraft(args: PublishVerifiedDraftArgs): Promise<void> {
  const posting = prepareReviewForPosting(args.draft);

  for (const reply of posting.replies) {
    await args.postReviewCommentReply(
      args.owner,
      args.repo,
      args.prNumber,
      reply.commentId,
      reply.body,
    );
  }

  await args.postInlineReview(
    args.owner,
    args.repo,
    args.prNumber,
    args.headSha,
    posting.body,
    posting.event,
    posting.comments,
  );
}
