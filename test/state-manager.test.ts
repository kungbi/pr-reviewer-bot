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

    it('preserves retry metadata when marking a pending retry PR as reviewing again', () => {
      state.markPRRetryFailure('owner', 'repo', 1, 'first failure');
      state.markPRReviewing('owner', 'repo', 1);
      expect(state.getPRRetryCount('owner', 'repo', 1)).toBe(1);
      expect(state.data.reviewedPRs['owner/repo#1'].failures).toHaveLength(1);
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

    it('persists a closed review thread so a later poll cannot reopen a human handoff', () => {
      const threadKey = 'owner/repo#1:thread:100';
      (state as any).markReviewThreadClosed(threadKey, 'human_handoff');
      expect((state as any).isReviewThreadClosed(threadKey)).toBe(true);

      const reloaded = new ReviewedPRsState(stateFile);
      reloaded.load();
      expect((reloaded as any).isReviewThreadClosed(threadKey)).toBe(true);
      expect((reloaded as any).data.closedReviewThreads[threadKey]).toEqual(expect.objectContaining({
        resolution: 'human_handoff',
      }));
    });

    it('durably reserves a single reconsideration before its external GitHub post', () => {
      const threadKey = 'owner/repo#1:thread:100';
      expect((state as any).reserveReviewThreadReconsideration(
        threadKey,
        'comment-101',
        'maintainer',
        'final reply <!-- marker -->',
        'head-sha',
        '<!-- marker -->',
      )).toBe(true);
      expect(state.isCommentReplied('comment-101')).toBe(true);
      expect((state as any).isReviewThreadClosed(threadKey)).toBe(true);

      const reloaded = new ReviewedPRsState(stateFile);
      reloaded.load();
      expect((reloaded as any).data.closedReviewThreads[threadKey]).toEqual(expect.objectContaining({
        resolution: 'reconsideration_pending',
        handledCommentLogin: 'maintainer',
        operationMarker: '<!-- marker -->',
        postAttempted: false,
      }));
      expect((reloaded as any).reserveReviewThreadReconsideration(threadKey, 'comment-102', 'maintainer', 'body', 'head', 'marker')).toBe(false);
      expect((reloaded as any).markReviewThreadReconsiderationPostAttempted(threadKey)).toBe(true);

      (reloaded as any).completeReviewThreadReconsideration(threadKey);
      expect((reloaded as any).data.closedReviewThreads[threadKey]).toEqual(expect.objectContaining({
        resolution: 'reconsidered_merge_boundary',
      }));
    });

    it('durably reserves and reconciles an ordinary review reply delivery', () => {
      const deliveryKey = 'owner/repo#1:comment:101';
      expect((state as any).reserveReviewReplyDelivery(
        deliveryKey,
        101,
        100,
        'reply body <!-- marker -->',
        'head-sha',
        '<!-- marker -->',
      )).toBe(true);
      expect(state.isCommentReplied(101)).toBe(false);
      expect((state as any).markReviewReplyDeliveryPostAttempted(deliveryKey)).toBe(true);
      expect((state as any).markReviewReplyDeliveryUnknown(deliveryKey)).toBe(true);

      const reloaded = new ReviewedPRsState(stateFile);
      reloaded.load();
      expect((reloaded as any).getReviewReplyDelivery(deliveryKey)).toEqual(expect.objectContaining({
        resolution: 'delivery_unknown',
        humanReplyId: '101',
        parentCommentId: 100,
        operationMarker: '<!-- marker -->',
        postAttempted: true,
      }));
      expect((reloaded as any).completeReviewReplyDelivery(deliveryKey)).toBe(true);
      expect(reloaded.isCommentReplied(101)).toBe(true);
      expect((reloaded as any).getReviewReplyDelivery(deliveryKey)).toBeUndefined();
    });

    it('preserves durable thread closures and reply outbox entries when pruning old PR metadata', () => {
      const prKey = 'owner/repo#1';
      const threadKey = `${prKey}:thread:100`;
      const deliveryKey = `${prKey}:comment:101`;
      state.markPRReviewed('owner', 'repo', 1, 'reviewed');
      state.markReviewThreadClosed(threadKey, 'human_handoff');
      state.reserveReviewReplyDelivery(deliveryKey, 101, 100, 'body', 'head', '<!-- marker -->');
      state.data.reviewedPRs[prKey].reviewedAt = '2000-01-01T00:00:00.000Z';
      state.save();

      expect(state.pruneOldEntries(1)).toBe(1);
      expect(state.data.closedReviewThreads?.[threadKey]).toEqual(expect.objectContaining({ resolution: 'human_handoff' }));
      expect(state.data.pendingReviewReplies?.[deliveryKey]).toEqual(expect.objectContaining({ resolution: 'pending' }));
    });

    it('returns only monitorable PRs within the reply lookback window', () => {
      state.markPRReviewed('owner', 'repo', 1, 'reviewed');
      state.markPRReviewed('owner', 'repo', 2, 'skipped');
      state.markPRReviewed('owner', 'repo', 3, 'needs_work');

      const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      state.data.reviewedPRs['owner/repo#3'].reviewedAt = oldDate;
      state.save();

      const prs = state.getPRsForReplyMonitoring(14);
      expect(prs.map((pr) => pr.prNumber)).toEqual([1]);
    });

    it('initializes and persists reply monitor watermark', () => {
      const startedAt = state.getReplyMonitorStartedAt();
      expect(startedAt).toBeTruthy();

      const state2 = new ReviewedPRsState(stateFile);
      state2.load();
      expect(state2.getReplyMonitorStartedAt()).toBe(startedAt);
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
