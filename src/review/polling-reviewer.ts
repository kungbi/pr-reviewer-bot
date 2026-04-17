/**
 * polling-reviewer.ts
 *
 * PR 리뷰 실행 래퍼 — 실패 시 재시도 로직 포함.
 */

import path from 'path';
import ReviewedPRsState, { MAX_RETRIES } from '../utils/state-manager';
import logger from '../utils/logger';
import { PRInfo, RetryOutcome, ReviewResult } from '../types';

const STATE_FILE = path.join(process.cwd(), 'state/reviewed-prs.json');

/**
 * 상태 파일 로드 헬퍼 (singleton per run)
 */
function loadState(): ReviewedPRsState {
  const state = new ReviewedPRsState(STATE_FILE);
  state.load();
  return state;
}

/**
 * PR 리뷰를 안전하게 실행하는 래퍼.
 */
async function executeReviewWithRetry(
  prInfo: PRInfo,
  reviewFn: (prInfo: PRInfo) => Promise<ReviewResult>
): Promise<RetryOutcome> {
  const { owner, repo, prNumber, title } = prInfo;
  const prLabel = `${owner}/${repo}#${prNumber}`;

  const state = loadState();

  if (state.isPRSkipped(owner, repo, prNumber)) {
    logger.warn(`[PollingReviewer] PR ${prLabel} is permanently skipped after ${MAX_RETRIES} failures — skipping`);
    return { success: false, skipped: true, retryCount: MAX_RETRIES };
  }

  const currentRetries = state.getPRRetryCount(owner, repo, prNumber);
  logger.info(`[PollingReviewer] Starting review for PR ${prLabel} "${title}" (attempt ${currentRetries + 1}/${MAX_RETRIES})`);

  try {
    const result = await reviewFn(prInfo);

    state.clearPRRetries(owner, repo, prNumber);
    logger.info(`[PollingReviewer] Review succeeded for PR ${prLabel}`);
    return { success: true, skipped: false, retryCount: currentRetries, result };

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const timestamp = new Date().toISOString();

    logger.error(`[PollingReviewer] [${timestamp}] Review FAILED for PR ${prLabel} (attempt ${currentRetries + 1}) — ${errMsg}`);

    const newCount = state.markPRRetryFailure(owner, repo, prNumber, errMsg);

    if (newCount >= MAX_RETRIES) {
      logger.error(
        `[PollingReviewer] [${timestamp}] PR ${prLabel} has failed ${newCount}/${MAX_RETRIES} times — permanently skipping`
      );
      return { success: false, skipped: true, retryCount: newCount, error: errMsg };
    }

    logger.warn(
      `[PollingReviewer] PR ${prLabel} marked for retry (${newCount}/${MAX_RETRIES} failures so far)`
    );
    return { success: false, skipped: false, retryCount: newCount, error: errMsg };
  }
}

/**
 * PR 목록을 순회하면서 미리뷰 PR 처리.
 */
async function processPRList(
  prs: PRInfo[],
  reviewFn: (prInfo: PRInfo) => Promise<ReviewResult>
): Promise<Array<{ prLabel: string } & Partial<RetryOutcome> & { reason?: string }>> {
  const state = loadState();
  const results: Array<{ prLabel: string } & Partial<RetryOutcome> & { reason?: string }> = [];

  for (const prInfo of prs) {
    const { owner, repo, prNumber } = prInfo;
    const prLabel = `${owner}/${repo}#${prNumber}`;

    if (state.isPRReviewed(owner, repo, prNumber)) {
      logger.debug(`[PollingReviewer] Skipping already reviewed PR ${prLabel}`);
      results.push({ prLabel, skipped: true, reason: 'already_reviewed' });
      continue;
    }

    const outcome = await executeReviewWithRetry(prInfo, reviewFn);
    results.push({ prLabel, ...outcome });

    if (outcome.success) {
      state.markPRReviewed(owner, repo, prNumber, 'reviewed');
    }
  }

  return results;
}

export {
  executeReviewWithRetry,
  processPRList,
  MAX_RETRIES,
};
