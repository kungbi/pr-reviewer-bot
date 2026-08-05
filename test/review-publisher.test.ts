import { publishVerifiedDraft } from '../src/review/review-publisher';
import { ReviewDraft } from '../src/review/review-draft';
import { BOT_AUTHOR_DISCLOSURE } from '../src/utils/comment-disclosure';

describe('publishVerifiedDraft', () => {
  const draft: ReviewDraft = {
    summary: '검증을 통과한 이슈가 있습니다.',
    comments: [
      {
        path: 'src/service.ts',
        line: 20,
        side: 'RIGHT',
        severity: 'important',
        body: '🟡 **Important** — 실패를 삼키고 있습니다.',
      },
    ],
    replies: [
      { commentId: 11, severity: 'important', body: '기존 지적은 현재 커밋에서도 유효합니다.' },
    ],
  };

  it('posts only the verifier-retained draft, with authorship disclosure added by code', async () => {
    const postInlineReview = jest.fn().mockResolvedValue({ id: 1 });
    const postReviewCommentReply = jest.fn().mockResolvedValue({ id: 2 });

    await publishVerifiedDraft({
      owner: 'org',
      repo: 'repo',
      prNumber: 123,
      headSha: 'abc123',
      draft,
      postInlineReview,
      postReviewCommentReply,
    });

    expect(postReviewCommentReply).toHaveBeenCalledWith(
      'org', 'repo', 123, 11,
      expect.stringContaining(BOT_AUTHOR_DISCLOSURE),
    );
    expect(postInlineReview).toHaveBeenCalledWith(
      'org', 'repo', 123, 'abc123',
      expect.stringContaining(BOT_AUTHOR_DISCLOSURE),
      'COMMENT',
      [expect.objectContaining({
        path: 'src/service.ts',
        line: 20,
        body: expect.stringContaining(BOT_AUTHOR_DISCLOSURE),
      })],
    );
  });

  it('posts a non-approval review when an Important finding is attached to an existing thread', async () => {
    const postInlineReview = jest.fn().mockResolvedValue({ id: 1 });
    const postReviewCommentReply = jest.fn().mockResolvedValue({ id: 2 });
    const replyOnlyDraft: ReviewDraft = {
      summary: '기존 스레드에 인증 경로 500 이슈를 추가했습니다.',
      comments: [],
      replies: [{
        commentId: 11,
        severity: 'important',
        body: '반복 Authorization 쿼리가 배열로 전달되면 500이 발생합니다.',
      }],
    };

    await publishVerifiedDraft({
      owner: 'org', repo: 'repo', prNumber: 123, headSha: 'abc123',
      draft: replyOnlyDraft, postInlineReview, postReviewCommentReply,
    });

    expect(postInlineReview).toHaveBeenCalledWith(
      'org', 'repo', 123, 'abc123',
      expect.stringContaining('🟡 **Important 1건**'),
      'COMMENT',
      [],
    );
    expect(postReviewCommentReply).toHaveBeenCalledWith(
      'org', 'repo', 123, 11,
      expect.stringContaining('🟡 **Important**'),
    );
  });
});
