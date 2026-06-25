import { processReviewCommentReplies } from '../src/monitoring/comment-reply-monitor';
import { ReviewComment } from '../src/types';

describe('processReviewCommentReplies', () => {
  const botLogin = 'backend-woongbi';
  const baseArgs = {
    owner: 'fan-maum',
    repo: 'fanmaum-api',
    prNumber: 601,
    botLogin,
  };

  function comment(overrides: Partial<ReviewComment>): ReviewComment {
    return {
      id: 1,
      body: 'body',
      user: { login: 'someone' },
      path: 'src/file.ts',
      line: 10,
      diff_hunk: '@@ hunk',
      html_url: 'https://example.com/comment',
      created_at: '2026-06-25T00:00:00Z',
      updated_at: '2026-06-25T00:00:00Z',
      ...overrides,
    };
  }

  it('replies once to a human reply on a bot review comment when AI says reply is needed', async () => {
    const parent = comment({ id: 100, user: { login: botLogin }, body: 'Please handle invalid pagination.' });
    const humanReply = comment({ id: 101, in_reply_to_id: 100, user: { login: 'jhoon03' }, body: 'Is this already covered by ValidationPipe?' });
    const isCommentReplied = jest.fn().mockReturnValue(false);
    const markCommentReplied = jest.fn();
    const judgeAndDraftReply = jest.fn().mockResolvedValue({ verdict: 'REPLY_NEEDED', body: 'Yes, this is covered by DTO validation.' });
    const postReviewCommentReply = jest.fn().mockResolvedValue({ id: 999 });

    const result = await processReviewCommentReplies({
      ...baseArgs,
      comments: [parent, humanReply],
      isCommentReplied,
      markCommentReplied,
      judgeAndDraftReply,
      postReviewCommentReply,
    });

    expect(judgeAndDraftReply).toHaveBeenCalledWith(expect.objectContaining({
      originalBotComment: parent,
      humanReply,
    }));
    expect(postReviewCommentReply).toHaveBeenCalledWith('fan-maum', 'fanmaum-api', 601, 100, 'Yes, this is covered by DTO validation.');
    expect(markCommentReplied).toHaveBeenCalledWith(101);
    expect(result).toEqual({ scanned: 2, candidates: 1, replied: 1, skipped: 0 });
  });

  it('marks a human reply as processed without posting when AI says no reply is needed', async () => {
    const parent = comment({ id: 100, user: { login: botLogin } });
    const humanReply = comment({ id: 101, in_reply_to_id: 100, user: { login: 'jhoon03' }, body: 'Thanks!' });
    const markCommentReplied = jest.fn();
    const postReviewCommentReply = jest.fn();

    const result = await processReviewCommentReplies({
      ...baseArgs,
      comments: [parent, humanReply],
      isCommentReplied: jest.fn().mockReturnValue(false),
      markCommentReplied,
      judgeAndDraftReply: jest.fn().mockResolvedValue({ verdict: 'NO_REPLY' }),
      postReviewCommentReply,
    });

    expect(postReviewCommentReply).not.toHaveBeenCalled();
    expect(markCommentReplied).toHaveBeenCalledWith(101);
    expect(result).toEqual({ scanned: 2, candidates: 1, replied: 0, skipped: 1 });
  });

  it('skips replies older than the reply monitor watermark', async () => {
    const parent = comment({ id: 100, user: { login: botLogin }, created_at: '2026-06-25T00:00:00Z' });
    const oldReply = comment({
      id: 101,
      in_reply_to_id: 100,
      user: { login: 'jhoon03' },
      body: 'Can you explain this?',
      created_at: '2026-06-24T23:59:59Z',
    });
    const judgeAndDraftReply = jest.fn();

    const result = await processReviewCommentReplies({
      ...baseArgs,
      comments: [parent, oldReply],
      minReplyCreatedAt: '2026-06-25T00:00:00Z',
      isCommentReplied: jest.fn().mockReturnValue(false),
      markCommentReplied: jest.fn(),
      judgeAndDraftReply,
      postReviewCommentReply: jest.fn(),
    });

    expect(judgeAndDraftReply).not.toHaveBeenCalled();
    expect(result).toEqual({ scanned: 2, candidates: 0, replied: 0, skipped: 0 });
  });

  it('skips bot replies, already processed replies, and replies not attached to bot comments', async () => {
    const botParent = comment({ id: 100, user: { login: botLogin } });
    const otherParent = comment({ id: 200, user: { login: 'reviewer' } });
    const botSelfReply = comment({ id: 101, in_reply_to_id: 100, user: { login: botLogin } });
    const alreadyProcessed = comment({ id: 102, in_reply_to_id: 100, user: { login: 'human' } });
    const notForBot = comment({ id: 201, in_reply_to_id: 200, user: { login: 'human' } });
    const topLevel = comment({ id: 300, user: { login: 'human' } });
    const judgeAndDraftReply = jest.fn();

    const result = await processReviewCommentReplies({
      ...baseArgs,
      comments: [botParent, otherParent, botSelfReply, alreadyProcessed, notForBot, topLevel],
      isCommentReplied: jest.fn((id: string | number) => id === 102),
      markCommentReplied: jest.fn(),
      judgeAndDraftReply,
      postReviewCommentReply: jest.fn(),
    });

    expect(judgeAndDraftReply).not.toHaveBeenCalled();
    expect(result).toEqual({ scanned: 6, candidates: 0, replied: 0, skipped: 0 });
  });
});
