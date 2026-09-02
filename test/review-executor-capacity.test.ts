jest.mock('../src/github', () => ({
  getPRDetails: jest.fn(),
  getPRHeadSha: jest.fn(),
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
import { getPRDetails, getPRHeadSha } from '../src/github';
import { runReviewVerificationGate } from '../src/review/review-verification-gate';
import { getReviewMemoryContext } from '../src/review-memory/review-memory-service';
import { sendReviewFailedNotification } from '../src/discord-notifier';
import ReviewedPRsState from '../src/utils/state-manager';
import { ModelCapacityError } from '../src/utils/sessions_spawn';

const mockGetPRDetails = getPRDetails as jest.Mock;
const mockGetPRHeadSha = getPRHeadSha as jest.Mock;
const mockGetReviewMemoryContext = getReviewMemoryContext as jest.Mock;
const mockRunReviewVerificationGate = runReviewVerificationGate as jest.Mock;
const mockSendReviewFailedNotification = sendReviewFailedNotification as jest.Mock;

describe('executeReview capacity propagation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPRHeadSha.mockResolvedValue('head-sha');
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
  });
});
