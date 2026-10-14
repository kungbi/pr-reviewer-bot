import fs from 'fs';
import os from 'os';
import path from 'path';
import axios from 'axios';
import { postInlineReview } from '../src/github';
import ReviewedPRsState from '../src/utils/state-manager';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const owner = 'acme';
const repo = 'service';
const prNumber = 42;
const headSha = '0123456789abcdef0123456789abcdef01234567';
const body = '✅ **이슈 없음**\n\n---\n_🤖 이 댓글은 PR Reviewer Bot(AI)이 자동 작성했습니다._';
const publicationKey = `${owner}/${repo}#${prNumber}:${headSha}`;

describe('postInlineReview idempotency', () => {
  let stateFile: string;
  let state: ReviewedPRsState;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env.GH_TOKEN = 'test-token';
    stateFile = path.join(os.tmpdir(), `review-publication-test-${process.pid}-${Date.now()}-${Math.random()}.json`);
    fs.writeFileSync(stateFile, JSON.stringify({ reviewedPRs: {}, repliedComments: {} }), 'utf8');
    state = new ReviewedPRsState(stateFile);
    state.load();
  });

  afterEach(() => {
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  });

  const callReview = (
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' = 'APPROVE',
    prAuthor: string | null = 'author',
    reviewState: ReviewedPRsState = state,
  ) => (
    (postInlineReview as any)(owner, repo, prNumber, headSha, body, event, [], reviewState, prAuthor)
  );

  const mockReviewReads = (getReviews: () => unknown[]) => {
    mockedAxios.get.mockImplementation(async (url) => {
      if (String(url).endsWith('/user')) {
        return { data: { login: 'review-bot' }, headers: {} } as any;
      }
      return { data: getReviews(), headers: {} } as any;
    });
  };

  it('reconciles an ambiguous response when GitHub already persisted the exact marked review', async () => {
    let postedBody = '';
    mockedAxios.post.mockImplementationOnce(async (_url, payload) => {
      postedBody = (payload as { body: string }).body;
      throw Object.assign(new Error('Request failed with status code 422'), {
        response: { status: 422 },
      });
    });
    mockReviewReads(() => [{
      id: 9001,
      user: { login: 'review-bot' },
      commit_id: headSha,
      state: 'APPROVED',
      body: postedBody,
    }]);

    await expect(callReview()).resolves.toMatchObject({ id: 9001, state: 'APPROVED' });

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(postedBody).toContain('<!-- pr-reviewer-bot:review:');
    expect(postedBody).toMatch(/PR Reviewer Bot\(AI\).*_$/s);
    expect((state.data as any).reviewPublications[publicationKey]).toEqual(expect.objectContaining({
      status: 'completed',
      postAttempted: true,
      reviewId: 9001,
    }));
  });

  it('preserves a successful review POST when the returned rate limit is low', async () => {
    mockReviewReads(() => []);
    mockedAxios.post.mockResolvedValue({
      data: { id: 10, state: 'APPROVED' },
      headers: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '4102444800',
      },
    } as any);

    await expect(callReview()).resolves.toEqual({ id: 10, state: 'APPROVED' });

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect((state.data as any).reviewPublications[publicationKey]).toEqual(expect.objectContaining({
      status: 'completed',
      reviewId: 10,
    }));
  });

  it('falls back to COMMENT after an explicit 422 rejection and confirms the fallback once', async () => {
    mockReviewReads(() => []);
    mockedAxios.post
      .mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 422'), {
        response: { status: 422 },
      }))
      .mockResolvedValueOnce({ data: { id: 11, state: 'COMMENTED' }, headers: {} } as any);

    await expect(callReview('REQUEST_CHANGES')).resolves.toEqual({ id: 11, state: 'COMMENTED' });

    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    expect(mockedAxios.post.mock.calls.map(([, payload]) => (payload as { event: string }).event))
      .toEqual(['REQUEST_CHANGES', 'COMMENT']);
    expect((state.data as any).reviewPublications[publicationKey]).toEqual(expect.objectContaining({
      status: 'completed',
      reviewId: 11,
      postAttempted: true,
    }));
  });

  it('marks delivery unknown when post-write reconciliation itself fails', async () => {
    let postStarted = false;
    mockedAxios.get.mockImplementation(async (url) => {
      if (String(url).endsWith('/user')) {
        return { data: { login: 'review-bot' }, headers: {} } as any;
      }
      if (postStarted) throw new Error('review read-back unavailable');
      return { data: [], headers: {} } as any;
    });
    mockedAxios.post.mockImplementationOnce(async () => {
      postStarted = true;
      throw new Error('response lost after POST');
    });

    await expect(callReview()).rejects.toThrow(/delivery is unknown/i);

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect((state.data as any).reviewPublications[publicationKey]).toEqual(expect.objectContaining({
      status: 'delivery_unknown',
      postAttempted: true,
    }));
  });

  it('never posts again when recovering a delivery-unknown review without a marker', async () => {
    const marker = '<!-- pr-reviewer-bot:review:stored-marker -->';
    (state.data as any).reviewPublications = {
      [publicationKey]: {
        createdAt: new Date().toISOString(),
        status: 'delivery_unknown',
        owner,
        repo,
        prNumber,
        headSha,
        botLogin: 'review-bot',
        pendingBody: `${marker}\n${body}`,
        pendingEvent: 'APPROVE',
        pendingComments: [],
        operationMarker: marker,
        postAttempted: true,
      },
    };
    state.save();
    const recoveredState = new ReviewedPRsState(stateFile);
    recoveredState.load();
    mockReviewReads(() => []);
    mockedAxios.post.mockResolvedValue({ data: { id: 12 }, headers: {} } as any);

    await expect(callReview('APPROVE', 'author', recoveredState)).rejects.toThrow(/delivery is unknown/i);

    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('marks an attempted pending publication unknown when recovery read-back fails', async () => {
    const marker = '<!-- pr-reviewer-bot:review:stored-marker -->';
    (state.data as any).reviewPublications = {
      [publicationKey]: {
        createdAt: new Date().toISOString(),
        status: 'pending',
        owner,
        repo,
        prNumber,
        headSha,
        botLogin: 'review-bot',
        pendingBody: `${marker}\n${body}`,
        pendingEvent: 'APPROVE',
        pendingComments: [],
        operationMarker: marker,
        postAttempted: true,
      },
    };
    state.save();
    const recoveredState = new ReviewedPRsState(stateFile);
    recoveredState.load();
    mockedAxios.get.mockImplementation(async (url) => {
      if (String(url).endsWith('/user')) {
        return { data: { login: 'review-bot' }, headers: {} } as any;
      }
      throw new Error('recovery read-back unavailable');
    });

    await expect(callReview('APPROVE', 'author', recoveredState)).rejects.toThrow(/delivery is unknown/i);

    expect(mockedAxios.post).not.toHaveBeenCalled();
    const reloaded = new ReviewedPRsState(stateFile);
    reloaded.load();
    expect((reloaded.data as any).reviewPublications[publicationKey].status).toBe('delivery_unknown');
  });

  it('does not reconcile an embedded marker that is not an exact standalone line', async () => {
    let postedBody = '';
    mockedAxios.post.mockImplementationOnce(async (_url, payload) => {
      postedBody = (payload as { body: string }).body;
      throw new Error('response lost after POST');
    });
    mockReviewReads(() => {
      const marker = postedBody.split(/\r?\n/).find(line => line.includes('pr-reviewer-bot:review:')) ?? '';
      return [{
        id: 13,
        user: { login: 'review-bot' },
        commit_id: headSha,
        state: 'APPROVED',
        body: `quoted ${marker} text`,
      }];
    });

    await expect(callReview()).rejects.toThrow(/delivery is unknown/i);

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect((state.data as any).reviewPublications[publicationKey].status).toBe('delivery_unknown');
  });

  it('ignores exact markers attached to the wrong bot, head, or pending review', async () => {
    let postedBody = '';
    mockedAxios.post.mockImplementationOnce(async (_url, payload) => {
      postedBody = (payload as { body: string }).body;
      throw new Error('response lost after POST');
    });
    mockReviewReads(() => [
      { id: 20, user: { login: 'someone-else' }, commit_id: headSha, state: 'APPROVED', body: postedBody },
      { id: 21, user: { login: 'review-bot' }, commit_id: 'different-head', state: 'APPROVED', body: postedBody },
      { id: 22, user: { login: 'review-bot' }, commit_id: headSha, state: 'PENDING', body: postedBody },
    ]);

    await expect(callReview()).rejects.toThrow(/delivery is unknown/i);

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect((state.data as any).reviewPublications[publicationKey].status).toBe('delivery_unknown');
  });

  it('uses COMMENT as the single first write when the bot is the PR author', async () => {
    mockReviewReads(() => []);
    mockedAxios.post.mockResolvedValue({ data: { id: 14, state: 'COMMENTED' }, headers: {} } as any);

    await expect(callReview('APPROVE', 'review-bot')).resolves.toEqual({ id: 14, state: 'COMMENTED' });

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect((mockedAxios.post.mock.calls[0][1] as { event: string }).event).toBe('COMMENT');
  });

  it('uses COMMENT as the single first write when the PR author is unavailable', async () => {
    mockReviewReads(() => []);
    mockedAxios.post.mockResolvedValue({ data: { id: 15, state: 'COMMENTED' }, headers: {} } as any);

    await expect(callReview('APPROVE', null)).resolves.toEqual({ id: 15, state: 'COMMENTED' });

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect((mockedAxios.post.mock.calls[0][1] as { event: string }).event).toBe('COMMENT');
  });
});
