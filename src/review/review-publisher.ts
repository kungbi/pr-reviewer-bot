import { InlineComment, ReviewEvent } from '../types';
import { appendBotAuthorDisclosure, BOT_AUTHOR_DISCLOSURE } from '../utils/comment-disclosure';
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
  const replyUrls: string[] = [];

  for (const reply of posting.replies) {
    const postedReply = await args.postReviewCommentReply(
      args.owner,
      args.repo,
      args.prNumber,
      reply.commentId,
      reply.body,
    );
    if (hasHtmlUrl(postedReply)) {
      replyUrls.push(postedReply.html_url);
    }
  }

  const body = replyUrls.length > 0
    ? appendBotAuthorDisclosure([
      posting.body.replace(BOT_AUTHOR_DISCLOSURE, '').trim(),
      `**기존 스레드 답글 ${replyUrls.length}건**`,
      replyUrls.map((url, index) => `- [답글 ${index + 1} 보기](${url})`).join('\n'),
    ].join('\n\n'))
    : posting.body;

  await args.postInlineReview(
    args.owner,
    args.repo,
    args.prNumber,
    args.headSha,
    body,
    posting.event,
    posting.comments,
  );
}

function hasHtmlUrl(value: unknown): value is { html_url: string } {
  return typeof value === 'object'
    && value !== null
    && 'html_url' in value
    && typeof value.html_url === 'string'
    && value.html_url.length > 0;
}
