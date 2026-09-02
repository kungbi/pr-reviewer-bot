jest.mock('../src/utils/state-manager', () => ({
  MAX_RETRIES: 3,
  getSharedState: jest.fn(),
}));
jest.mock('../src/github', () => ({ postComment: jest.fn() }));
jest.mock('../src/discord-notifier', () => ({ sendReviewFailedNotification: jest.fn() }));

import { executeReviewWithRetry } from '../src/review/polling-reviewer';
import { getSharedState } from '../src/utils/state-manager';
import { ModelCapacityError } from '../src/utils/sessions_spawn';

const mockedGetSharedState = getSharedState as jest.Mock;

describe('executeReviewWithRetry', () => {
  it('does not consume permanent retry budget for a capacity failure', async () => {
    const state = {
      isPRSkipped: jest.fn().mockReturnValue(false),
      getPRRetryCount: jest.fn().mockReturnValue(0),
      clearPRRetries: jest.fn(),
      markPRRetryFailure: jest.fn(),
      markPRCapacityRetry: jest.fn(),
    };
    mockedGetSharedState.mockReturnValue(state);

    const outcome = await executeReviewWithRetry(
      { owner: 'org', repo: 'repo', prNumber: 123, title: 'review me' },
      async () => { throw new ModelCapacityError('temporary capacity'); },
    );

    expect(state.markPRRetryFailure).not.toHaveBeenCalled();
    expect(state.markPRCapacityRetry).toHaveBeenCalledWith('org', 'repo', 123, expect.stringContaining('server_overloaded'));
    expect(outcome).toMatchObject({ success: false, skipped: false, retryCount: 0 });
    expect(outcome.error).toContain('server_overloaded');
  });
});
