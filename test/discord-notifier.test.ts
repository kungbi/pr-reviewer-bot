const mockFetch = jest.fn();
global.fetch = mockFetch;

process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test/mock';
process.env.BOT_NAME = 'test-bot';

import {
  sendDiscordNotification,
  sendReviewCompletedNotification,
  sendPRAssignedNotification,
  sendReviewCommentReplyNotification,
} from '../src/discord-notifier';

beforeEach(() => {
  mockFetch.mockReset();
});

describe('sendDiscordNotification', () => {
  it('dispatches pr_assigned event', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '' });
    const result = await sendDiscordNotification('pr_assigned', {
      repoOwner: 'org', repoName: 'repo', prNumber: 1, prTitle: 'Test PR',
      prUrl: 'https://github.com/org/repo/pull/1', action: 'assigned',
    });
    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns false for unknown event type', async () => {
    const result = await sendDiscordNotification('unknown_event', { prNumber: 0, prTitle: '' });
    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('sendReviewCompletedNotification', () => {
  it('sends green embed when no issues found', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '' });
    const result = await sendReviewCompletedNotification({
      owner: 'org', repo: 'repo', prNumber: 2,
      prTitle: 'Clean PR', issuesFound: [],
    });
    expect(result).toBe(true);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.embeds[0].color).toBe(0x10B981);
  });

  it('sends red embed when issues found', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '' });
    await sendReviewCompletedNotification({
      owner: 'org', repo: 'repo', prNumber: 3,
      prTitle: 'Buggy PR', issuesFound: ['Bug 1', 'Bug 2'],
    });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.embeds[0].color).toBe(0xEF4444);
  });

  it('truncates issues list to 5', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '' });
    const issues = Array.from({ length: 8 }, (_, i) => `Issue ${i + 1}`);
    await sendReviewCompletedNotification({
      owner: 'org', repo: 'repo', prNumber: 4,
      prTitle: 'Many issues', issuesFound: issues,
    });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const issueField = body.embeds[0].fields.find((f: { name: string }) => f.name === 'Issues Found');
    expect(issueField.value).toContain('and 3 more');
  });

  it('retries on failure and succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'error' })
      .mockResolvedValueOnce({ ok: true, text: async () => '' });
    const result = await sendReviewCompletedNotification({
      owner: 'org', repo: 'repo', prNumber: 5,
      prTitle: 'PR', issuesFound: [],
    });
    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns false after all retries exhausted', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'error' });
    const result = await sendReviewCompletedNotification({
      owner: 'org', repo: 'repo', prNumber: 6,
      prTitle: 'PR', issuesFound: [],
    });
    expect(result).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

describe('sendPRAssignedNotification', () => {
  it('sends notification with correct embed title', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '' });
    await sendPRAssignedNotification({
      repoOwner: 'org', repoName: 'repo', prNumber: 7,
      prTitle: 'New PR', prUrl: 'https://github.com/org/repo/pull/7',
    });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.embeds[0].title).toContain('#7');
  });
});

describe('sendReviewCommentReplyNotification', () => {
  it('sends human reply content to Discord', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '' });
    await sendReviewCommentReplyNotification({
      owner: 'org', repo: 'repo', prNumber: 8, prTitle: 'PR #8',
      commenter: 'dev1', commentId: 101, parentCommentId: 100,
      commentBody: '이거 이미 ValidationPipe에서 막히지 않나요?',
      commentUrl: 'https://github.com/org/repo/pull/8#discussion_r101',
      replyAction: 'human_replied',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.embeds[0].title).toContain('리뷰 댓글 답글 감지');
    expect(body.embeds[0].fields.find((f: { name: string }) => f.name === 'Human Reply').value).toContain('ValidationPipe');
  });

  it('sends bot reply content to Discord', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '' });
    await sendReviewCommentReplyNotification({
      owner: 'org', repo: 'repo', prNumber: 9, prTitle: 'PR #9',
      commenter: 'dev1', commentId: 201, parentCommentId: 200,
      commentBody: '설명 부탁드립니다.',
      botReplyBody: '확인 결과 현재 경로에서는 DTO 검증으로 차단됩니다.',
      replyUrl: 'https://github.com/org/repo/pull/9#discussion_r202',
      replyAction: 'bot_replied',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.embeds[0].title).toContain('봇 답글 게시');
    expect(body.embeds[0].fields.find((f: { name: string }) => f.name === 'Bot Reply').value).toContain('DTO 검증');
  });
});
