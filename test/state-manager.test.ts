import fs from 'fs';
import os from 'os';
import path from 'path';
import ReviewedPRsState from '../src/utils/state-manager';

const tmpFile = () => path.join(os.tmpdir(), `state-test-${Date.now()}.json`);

describe('ReviewedPRsState', () => {
  let stateFile: string;
  let state: ReviewedPRsState;

  beforeEach(() => {
    stateFile = tmpFile();
    state = new ReviewedPRsState(stateFile);
    state.load();
  });

  afterEach(() => {
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  });

  describe('PR review tracking', () => {
    it('marks and detects a reviewed PR', () => {
      state.markPRReviewed('owner', 'repo', 1);
      expect(state.isPRReviewed('owner', 'repo', 1)).toBe(true);
    });

    it('returns false for unknown PR', () => {
      expect(state.isPRReviewed('owner', 'repo', 999)).toBe(false);
    });

    it('checks SHA match when headSha provided', () => {
      state.markPRReviewed('owner', 'repo', 1, 'reviewed', 'abc123');
      expect(state.isPRReviewed('owner', 'repo', 1, 'abc123')).toBe(true);
      expect(state.isPRReviewed('owner', 'repo', 1, 'different')).toBe(false);
    });

    it('isPRCompleted returns true for reviewed/completed/skipped', () => {
      state.markPRReviewed('owner', 'repo', 1, 'reviewed');
      state.markPRReviewed('owner', 'repo', 2, 'completed');
      state.markPRReviewed('owner', 'repo', 3, 'skipped');
      expect(state.isPRCompleted('owner', 'repo', 1)).toBe(true);
      expect(state.isPRCompleted('owner', 'repo', 2)).toBe(true);
      expect(state.isPRCompleted('owner', 'repo', 3)).toBe(true);
    });

    it('isPRCompleted returns false for reviewing/pending_retry', () => {
      state.markPRReviewing('owner', 'repo', 1);
      expect(state.isPRCompleted('owner', 'repo', 1)).toBe(false);
    });
  });

  describe('in-progress lock', () => {
    it('marks and detects reviewing state', () => {
      state.markPRReviewing('owner', 'repo', 1);
      expect(state.isPRReviewing('owner', 'repo', 1)).toBe(true);
    });

    it('returns false for non-reviewing PR', () => {
      expect(state.isPRReviewing('owner', 'repo', 999)).toBe(false);
    });
  });

  describe('retry logic', () => {
    it('increments retry count on failure', () => {
      const count = state.markPRRetryFailure('owner', 'repo', 1, 'error');
      expect(count).toBe(1);
      expect(state.getPRRetryCount('owner', 'repo', 1)).toBe(1);
    });

    it('marks as skipped after MAX_RETRIES failures', () => {
      state.markPRRetryFailure('owner', 'repo', 1, 'err1');
      state.markPRRetryFailure('owner', 'repo', 1, 'err2');
      state.markPRRetryFailure('owner', 'repo', 1, 'err3');
      expect(state.isPRSkipped('owner', 'repo', 1)).toBe(true);
    });

    it('isPRPendingRetry is true before max retries', () => {
      state.markPRRetryFailure('owner', 'repo', 1, 'err');
      expect(state.isPRPendingRetry('owner', 'repo', 1)).toBe(true);
    });

    it('clearPRRetries resets state to reviewed', () => {
      state.markPRRetryFailure('owner', 'repo', 1, 'err');
      state.clearPRRetries('owner', 'repo', 1);
      expect(state.getPRRetryCount('owner', 'repo', 1)).toBe(0);
      expect(state.isPRPendingRetry('owner', 'repo', 1)).toBe(false);
    });
  });

  describe('comment reply tracking', () => {
    it('marks and detects replied comment', () => {
      state.markCommentReplied('comment-1');
      expect(state.isCommentReplied('comment-1')).toBe(true);
    });

    it('returns false for unknown comment', () => {
      expect(state.isCommentReplied('unknown')).toBe(false);
    });
  });

  describe('persistence', () => {
    it('persists state to disk and reloads', () => {
      state.markPRReviewed('owner', 'repo', 42);
      const state2 = new ReviewedPRsState(stateFile);
      state2.load();
      expect(state2.isPRReviewed('owner', 'repo', 42)).toBe(true);
    });
  });
});
