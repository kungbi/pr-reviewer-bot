/**
 * polling-reviewer.ts
 *
 * PR 리뷰 실행 래퍼 — 실패 시 재시도 로직 포함.
 */

import { MAX_RETRIES, getSharedState } from '../utils/state-manager';
import { sendReviewFailedNotification } from '../discord-notifier';
import { postComment } from '../github';
import config from '../utils/config';
import logger from '../utils/logger';
import { PRInfo, RetryOutcome, ReviewResult } from '../types';

/**
 * PR 리뷰를 안전하게 실행하는 래퍼.
 */
async function executeReviewWithRetry(
  prInfo: PRInfo,
  reviewFn: (prInfo: PRInfo) => Promise<ReviewResult>
): Promise<RetryOutcome> {
  const { owner, repo, prNumber, title } = prInfo;
  const prLabel = `${owner}/${repo}#${prNumber}`;

  const state = getSharedState();

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
      try {
        await postComment(
          owner,
          repo,
          prNumber,
          `🕷️ **Auto-Review Failed**\n\nCould not complete AI analysis for #${prNumber} after ${MAX_RETRIES} attempts. Please review manually.\n\n---\n*— ${config.botName}*`
        );
      } catch (postErr) {
        logger.error(`[PollingReviewer] Failed to post fallback comment: ${(postErr as Error).message}`);
      }
      try {
        await sendReviewFailedNotification({
          owner, repo, prNumber,
          prTitle: title ?? `PR #${prNumber}`,
          errorMessage: errMsg,
          permanentlySkipped: true,
        });
      } catch (notifyErr) {
        logger.warn(`[PollingReviewer] Discord skip notification failed: ${(notifyErr as Error).message}`);
      }
      return { success: false, skipped: true, retryCount: newCount, error: errMsg };
    }

    logger.warn(
      `[PollingReviewer] PR ${prLabel} marked for retry (${newCount}/${MAX_RETRIES} failures so far)`
    );
    return { success: false, skipped: false, retryCount: newCount, error: errMsg };
  }
}

export {
  executeReviewWithRetry,
  MAX_RETRIES,
};
