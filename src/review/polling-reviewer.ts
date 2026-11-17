/**
 * polling-reviewer.ts
 *
 * PR 리뷰 실행 래퍼 — 실패 시 재시도 로직 포함.
 */

import { MAX_RETRIES, getSharedState } from '../utils/state-manager';
import { sendReviewFailedNotification } from '../discord-notifier';
import { getPRHeadSha, postComment } from '../github';
import { appendBotAuthorDisclosure } from '../utils/comment-disclosure';
import config from '../utils/config';
import logger from '../utils/logger';
import { readReportOutbox, ReportPublicationAmbiguousError, ReportRecoveryError } from './review-report-outbox';
import { ModelCapacityError } from '../utils/sessions_spawn';
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

  let headSha = prInfo.headSha;
  if (headSha === undefined) {
    try { headSha = await getPRHeadSha(owner, repo, prNumber); }
    catch { headSha = null; }
  }
  const recovering = headSha ? readReportOutbox(owner, repo, prNumber, headSha) : null;
  if (!recovering && !state.beginPRRetryAttempt(owner, repo, prNumber, headSha ?? null)) {
    logger.warn(`[PollingReviewer] ${prLabel}: retry gate closed (exhausted, in-progress, or revision unknown)`);
    return { success: false, skipped: true, retryCount: state.getPRRetryCount(owner, repo, prNumber) };
  }

  const currentRetries = state.getPRRetryCount(owner, repo, prNumber);
  logger.info(`[PollingReviewer] Starting review for PR ${prLabel} "${title}" (attempt ${currentRetries + 1}/${MAX_RETRIES})`);

  try {
    const result = await reviewFn({ ...prInfo, headSha });

    try {
      if (headSha) state.completePRRetryAttempt(owner, repo, prNumber, headSha);
    } catch (cleanupError) {
      // Success is not a semantic failure even if local cleanup fails.
      logger.error(`[PollingReviewer] Retry cleanup failed after review success: ${(cleanupError as Error).message}`);
    }
    logger.info(`[PollingReviewer] Review succeeded for PR ${prLabel}`);
    return { success: true, skipped: false, retryCount: currentRetries, result };

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const timestamp = new Date().toISOString();

    if (err instanceof ReportPublicationAmbiguousError || err instanceof ReportRecoveryError) {
      state.markPRCapacityRetry(owner, repo, prNumber, errMsg, recovering ? undefined : headSha ?? undefined);
      logger.error(`[PollingReviewer] ${prLabel}: ${errMsg}; no fallback GitHub write will be attempted`);
      return { success: false, skipped: false, retryCount: currentRetries, error: errMsg };
    }
    if (err instanceof ModelCapacityError) {
      state.markPRCapacityRetry(owner, repo, prNumber, errMsg, recovering ? undefined : headSha ?? undefined);
      logger.warn(
        `[PollingReviewer] [${timestamp}] Capacity unavailable for PR ${prLabel}; ` +
        `stage=${err.stage ?? 'unknown'}, capacityAttempts=${err.attempts ?? 1}/${MAX_RETRIES}, ` +
        `model=${config.reviewModel ?? 'default'}, fallbackAllowed=false. ` +
        'PR remains eligible for the next poll; permanent retry budget is unchanged.'
      );
      return { success: false, skipped: false, retryCount: currentRetries, error: errMsg };
    }

    logger.error(`[PollingReviewer] [${timestamp}] Review FAILED for PR ${prLabel} (attempt ${currentRetries + 1}) — ${errMsg}`);

    // Report recovery cannot enter a fresh failure-notification path.
    if (recovering || !headSha) {
      state.markPRCapacityRetry(owner, repo, prNumber, errMsg, recovering ? undefined : headSha ?? undefined);
      return { success: false, skipped: false, retryCount: currentRetries, error: errMsg };
    }
    const newCount = state.recordPRRevisionFailure(owner, repo, prNumber, headSha, errMsg);

    if (newCount >= MAX_RETRIES) {
      logger.error(
        `[PollingReviewer] [${timestamp}] PR ${prLabel} has failed ${newCount}/${MAX_RETRIES} times — permanently skipping`
      );
      if (!state.reserveFailureNotification(owner, repo, prNumber, headSha)) {
        return { success: false, skipped: true, retryCount: newCount, error: errMsg };
      }
      let delivered = true;
      // Provider credentials are operator work, not a PR-author action. No
      // credential access or login here, and no GitHub fallback for auth faults.
      const authFailure = /refresh[_ -]?token|refresh401|401\s+Unauthorized|authentication (?:failed|error)|not (?:logged|signed) in/i.test(errMsg);
      try {
        if (!authFailure) await postComment(
          owner,
          repo,
          prNumber,
          appendBotAuthorDisclosure(
            `🕷️ **Auto-Review Failed**\n\nCould not complete AI analysis for #${prNumber} after ${MAX_RETRIES} attempts. Please review manually.\n\n*— ${config.botName}*`
          )
        );
      } catch (postErr) {
        delivered = false;
        logger.error(`[PollingReviewer] Failed to post fallback comment: ${(postErr as Error).message}`);
      }
      try {
        const notified = await sendReviewFailedNotification({
          owner, repo, prNumber,
          prTitle: title ?? `PR #${prNumber}`,
          errorMessage: errMsg,
          permanentlySkipped: true,
        });
        if (notified === false) delivered = false;
      } catch (notifyErr) {
        delivered = false;
        logger.warn(`[PollingReviewer] Discord skip notification failed: ${(notifyErr as Error).message}`);
      }
      state.finishFailureNotification(owner, repo, prNumber, headSha, delivered);
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
