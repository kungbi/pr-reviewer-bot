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
  getReviewMemoryContext: jest.fn(() => ({ lessons: [] })),
}));
jest.mock('../src/utils/agent-command', () => ({
  ...jest.requireActual('../src/utils/agent-command'),
  shouldUseLocalClone: jest.fn(() => true),
}));
jest.mock('../src/review/repo-cloner', () => ({
  cloneRepoForPR: jest.fn(),
  cleanupClone: jest.fn(),
}));
jest.mock('../src/review/repository-cache', () => ({
  getSharedRepositoryCache: jest.fn(),
}));
jest.mock('../src/discord-notifier', () => ({
  sendReviewStartedNotification: jest.fn(),
  sendReviewFailedNotification: jest.fn(),
  sendReviewCompletedNotification: jest.fn(),
}));

import { executeReview } from '../src/review/review-executor';
import { getPRDetails, getPRHeadSha, postInlineReview, verifyReviewPosted } from '../src/github';
import { runReviewVerificationGate } from '../src/review/review-verification-gate';
import { cloneRepoForPR } from '../src/review/repo-cloner';
import { getSharedRepositoryCache } from '../src/review/repository-cache';
import ReviewedPRsState from '../src/utils/state-manager';

const mockGetPRDetails = getPRDetails as jest.Mock;
const mockGetPRHeadSha = getPRHeadSha as jest.Mock;
const mockVerifyReviewPosted = verifyReviewPosted as jest.Mock;
const mockPostInlineReview = postInlineReview as jest.Mock;
const mockRunReviewVerificationGate = runReviewVerificationGate as jest.Mock;
const mockCloneRepoForPR = cloneRepoForPR as jest.Mock;
const mockGetSharedRepositoryCache = getSharedRepositoryCache as jest.Mock;

describe('executeReview persistent repository cache integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPRHeadSha.mockResolvedValue('head-sha');
    mockGetPRDetails.mockResolvedValue({
      title: 'Cross-repo contract',
      url: 'https://github.com/org/api/pull/123',
      author: { login: 'author' },
      headRefName: 'feature',
      baseRefName: 'main',
    });
    mockVerifyReviewPosted.mockResolvedValue(true);
    mockRunReviewVerificationGate.mockResolvedValue({ summary: 'ok', comments: [], replies: [] });
  });

  it('uses the cached PR worktree and supplies selector context before review', async () => {
    const cache = {
      preparePRWorkspace: jest.fn().mockResolvedValue({ ok: true, path: '/tmp/pr-worktree', headSha: 'workspace-head-sha' }),
      cleanupPRWorkspace: jest.fn().mockResolvedValue(undefined),
      getCatalog: jest.fn().mockReturnValue([
        {
          owner: 'org', repo: 'api', fullName: 'org/api', description: 'API',
          defaultBranch: 'main', path: '/cache/org/api',
        },
        {
          owner: 'org', repo: 'worker', fullName: 'org/worker', description: 'Worker',
          defaultBranch: 'main', path: '/cache/org/worker',
        },
      ]),
      getCatalogPath: jest.fn().mockReturnValue('/cache/repositories.json'),
      refreshRepositories: jest.fn().mockResolvedValue(undefined),
    };
    mockGetSharedRepositoryCache.mockReturnValue(cache);
    const state = {
      isPRReviewed: jest.fn().mockReturnValue(false),
      isPRCompleted: jest.fn().mockReturnValue(false),
      getReviewedHeadSha: jest.fn().mockReturnValue(null),
      markPRReviewed: jest.fn(),
    } as unknown as ReviewedPRsState;

    await expect(executeReview('org', 'api', 123, state)).resolves.toMatchObject({ success: true });

    expect(cache.preparePRWorkspace).toHaveBeenCalledWith({ owner: 'org', repo: 'api', prNumber: 123 });
    expect(mockCloneRepoForPR).not.toHaveBeenCalled();
    expect(mockRunReviewVerificationGate).toHaveBeenCalledWith(expect.objectContaining({
      clonePath: '/tmp/pr-worktree',
      baseBranch: 'main',
      repositoryCatalog: cache.getCatalog(),
      repositoryCatalogPath: '/cache/repositories.json',
      refreshSelectedRepositories: expect.any(Function),
    }));
    const gateArgs = mockRunReviewVerificationGate.mock.calls[0][0];
    await gateArgs.refreshSelectedRepositories(['org/worker']);
    expect(cache.refreshRepositories).toHaveBeenCalledWith(['org/worker']);
    await gateArgs.publish({ summary: 'verified', comments: [], replies: [] });
    expect(mockPostInlineReview).toHaveBeenCalledWith(
      'org', 'api', 123, 'workspace-head-sha', expect.any(String), 'APPROVE', [],
    );
    expect(cache.cleanupPRWorkspace).toHaveBeenCalledWith('/tmp/pr-worktree');
  });
});
