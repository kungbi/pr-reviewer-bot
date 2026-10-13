jest.mock('../src/github', () => ({
  getPRDetails: jest.fn(),
  getPRHeadSha: jest.fn(),
  listReviewThreads: jest.fn(),
  postInlineReview: jest.fn(),
  postReviewCommentReply: jest.fn(),
  verifyReviewPosted: jest.fn(),
}));
jest.mock('../src/review/review-verification-gate', () => ({
  runReviewVerificationGate: jest.fn(),
}));
jest.mock('../src/review-memory/review-memory-service', () => ({
  getReviewMemoryContext: jest.fn(),
}));
jest.mock('../src/utils/agent-command', () => ({
  ...jest.requireActual('../src/utils/agent-command'),
  shouldUseLocalClone: jest.fn(() => false),
}));
jest.mock('../src/discord-notifier', () => ({
  sendReviewStartedNotification: jest.fn(),
  sendReviewFailedNotification: jest.fn(),
  sendReviewCompletedNotification: jest.fn(),
}));

import { executeReview } from '../src/review/review-executor';
import { getPRDetails, getPRHeadSha, listReviewThreads, verifyReviewPosted } from '../src/github';
import { runReviewVerificationGate } from '../src/review/review-verification-gate';
import { getReviewMemoryContext } from '../src/review-memory/review-memory-service';
import { sendReviewFailedNotification } from '../src/discord-notifier';
import ReviewedPRsState from '../src/utils/state-manager';
import { ModelCapacityError } from '../src/utils/sessions_spawn';

const mockGetPRDetails = getPRDetails as jest.Mock;
const mockGetPRHeadSha = getPRHeadSha as jest.Mock;
const mockListReviewThreads = listReviewThreads as jest.Mock;
const mockVerifyReviewPosted = verifyReviewPosted as jest.Mock;
const mockGetReviewMemoryContext = getReviewMemoryContext as jest.Mock;
const mockRunReviewVerificationGate = runReviewVerificationGate as jest.Mock;
const mockSendReviewFailedNotification = sendReviewFailedNotification as jest.Mock;

describe('executeReview capacity propagation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunReviewVerificationGate.mockReset();
    mockGetPRHeadSha.mockResolvedValue('head-sha');
    mockListReviewThreads.mockResolvedValue([]);
    mockVerifyReviewPosted.mockResolvedValue(true);
    mockGetReviewMemoryContext.mockReturnValue({ lessons: [] });
    mockGetPRDetails.mockResolvedValue({
      title: 'Capacity retry',
      url: 'https://github.com/org/repo/pull/123',
      author: { login: 'author' },
      headRefName: 'feature',
      baseRefName: 'main',
    });
  });

  it('preserves a capacity error for polling retry instead of converting it to a semantic failure', async () => {
    mockRunReviewVerificationGate.mockRejectedValue(
      new ModelCapacityError('Selected model is at capacity', 'verifier', 3),
    );
    const state = {
      isPRReviewed: jest.fn().mockReturnValue(false),
      isPRCompleted: jest.fn().mockReturnValue(false),
      getReviewedHeadSha: jest.fn().mockReturnValue(null),
      markPRReviewed: jest.fn(),
    } as unknown as ReviewedPRsState;

    await expect(executeReview('org', 'repo', 123, state)).rejects.toBeInstanceOf(ModelCapacityError);

    expect(mockSendReviewFailedNotification).not.toHaveBeenCalled();
    expect(mockRunReviewVerificationGate).toHaveBeenCalledWith(expect.objectContaining({ reviewThreads: [] }));
  });

  it('fails closed before drafting when the current review-thread snapshot cannot be fetched', async () => {
    mockListReviewThreads.mockRejectedValue(new Error('GraphQL thread read failed'));
    const state = {
      isPRReviewed: jest.fn().mockReturnValue(false),
      isPRCompleted: jest.fn().mockReturnValue(false),
      getReviewedHeadSha: jest.fn().mockReturnValue(null),
      markPRReviewed: jest.fn(),
    } as unknown as ReviewedPRsState;

    await expect(executeReview('org', 'repo', 123, state)).rejects.toThrow('서브에이전트 실행 실패');

    expect(mockListReviewThreads).toHaveBeenCalledWith('org', 'repo', 123);
    expect(mockRunReviewVerificationGate).not.toHaveBeenCalled();
    expect((state as unknown as { markPRReviewed: jest.Mock }).markPRReviewed).not.toHaveBeenCalled();
  });

  it('provides the fetched current thread snapshot to both review agents through the verification gate', async () => {
    const reviewThreads = [{
      id: 'PRRT_1', rootCommentId: 11, isResolved: false, isOutdated: false,
      path: 'src/service.ts', line: 5, originalLine: 5,
      comments: [{
        id: 11, body: '기존 지적', user: { login: 'reviewer' },
        createdAt: '', updatedAt: '', url: '', inReplyToId: null,
      }],
    }];
    mockListReviewThreads.mockResolvedValue(reviewThreads);
    mockRunReviewVerificationGate.mockImplementation(async (args: { publish: (draft: unknown) => Promise<void> }) => {
      const draft = {
        summary: '기존 지적 확인', comments: [], replies: [],
        existingFindings: [{
          commentId: 11, status: 'still_applies', severity: 'minor', body: '현재 지적이 여전히 유효합니다.',
        }],
      };
      await args.publish(draft);
      return draft;
    });
    const state = {
      isPRReviewed: jest.fn().mockReturnValue(false),
      isPRCompleted: jest.fn().mockReturnValue(false),
      getReviewedHeadSha: jest.fn().mockReturnValue(null),
      markPRReviewed: jest.fn(),
    } as unknown as ReviewedPRsState;

    await expect(executeReview('org', 'repo', 123, state)).resolves.toMatchObject({
      success: true,
      verdict: 'approved',
      commentPosted: true,
    });

    expect(mockRunReviewVerificationGate).toHaveBeenCalledWith(expect.objectContaining({ reviewThreads }));
    expect((state as unknown as { markPRReviewed: jest.Mock }).markPRReviewed).toHaveBeenCalled();
  });
});
