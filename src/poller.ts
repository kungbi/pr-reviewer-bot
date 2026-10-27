import { listReportOutbox, readReportOutbox } from './review/review-report-outbox';
import cron from 'node-cron';
import axios from 'axios';
import { executeReviewWithRetry } from './review/polling-reviewer';
import { executeReview, isReviewDraining } from './review/review-executor';
import { getPRHeadSha, getAuthenticatedLogin, getRepositoryPermission, listReviewComments, postReviewCommentReply } from './github';
import { judgeAndDraftReply, processReviewCommentReplies } from './monitoring/comment-reply-monitor';
import { sendDiscordNotification } from './discord-notifier';
import { archiveAndMaybeLearnFromThread } from './review-memory/review-memory-service';
import { getSharedReviewMemoryStore } from './review-memory/review-memory-store';
import { getSharedState } from './utils/state-manager';
import { GracefulShutdown, GracefulShutdownResult } from './utils/graceful-shutdown';
import config from './utils/config';
import logger from './utils/logger';
import { PRInfo, RetryOutcome } from './types';

const GH_API = 'https://api.github.com';

interface GitHubPRItem {
  number: number;
  title: string;
  html_url: string;
}

type ShouldStop = () => boolean;

function getReviewThreadKey(owner: string, repo: string, prNumber: number, rootCommentId: number): string {
  return `${owner}/${repo}#${prNumber}:thread:${rootCommentId}`;
}

function getReviewReplyDeliveryKey(owner: string, repo: string, prNumber: number, humanReplyId: number): string {
  return `${owner}/${repo}#${prNumber}:comment:${humanReplyId}`;
}

export interface PollingController {
  stop(timeoutMs: number): Promise<GracefulShutdownResult>;
}

function getHeaders(): Record<string, string> {
  return {
    Authorization: `token ${process.env.GH_TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
  };
}

async function searchPRsForReviewer(limit = 100): Promise<GitHubPRItem[]> {
  const username = config.githubReviewer;
  const url = `${GH_API}/search/issues?q=type:pr+state:open+review-requested:${username}&per_page=${limit}`;
  const res = await axios.get<{ items: GitHubPRItem[] }>(url, { headers: getHeaders() });
  return res.data.items || [];
}

function getRepoInfo(pr: GitHubPRItem): { owner: string; name: string } {
  const match = (pr.html_url || '').match(/github\.com\/([^/]+)\/([^/]+)/);
  return {
    owner: match ? match[1] : 'unknown',
    name: match ? match[2] : 'unknown',
  };
}

let assignedPollInFlight = false;

async function pollAssignedPRs(shouldStop: ShouldStop = () => false): Promise<void> {
  if (shouldStop()) {
    logger.info('[POLLER] Draining; skipping assigned-PR poll');
    return;
  }
  if (assignedPollInFlight) return;
  assignedPollInFlight = true;
  logger.info('[POLLER] Checking for assigned PRs...');

  try {
    const state = getSharedState();
    const recovering = new Set<string>();
    for (const entry of listReportOutbox()) {
      if (shouldStop()) return;
      const key = `${entry.owner.toLowerCase()}/${entry.repo.toLowerCase()}#${entry.prNumber}`;
      recovering.add(`${key}:${entry.headSha.toLowerCase()}`);
      try { await executeReview(entry.owner, entry.repo, entry.prNumber, state, entry.headSha); }
      catch (err) { logger.warn(`[POLLER] Outbox recovery failed for ${key}: ${(err as Error).message}`); }
    }
    const itemsRaw = await searchPRsForReviewer(100);
    const items: GitHubPRItem[] = Array.isArray(itemsRaw) ? itemsRaw : [];

    logger.info(`[POLLER] Found ${items.length} PR(s) where I am requested as reviewer`);
    if (items.length === 0) return;
    if (shouldStop()) {
      logger.info('[POLLER] Draining; not starting discovered PR reviews');
      return;
    }

    const newPRs: Array<{ pr: GitHubPRItem; owner: string; repo: string; headSha: string | null }> = [];
    for (const pr of items) {
      if (shouldStop()) {
        logger.info('[POLLER] Draining; stopped PR discovery before state was locked');
        return;
      }
      const { owner, name: repo } = getRepoInfo(pr);
      const prLabel = `${owner}/${repo}#${pr.number}`;

      // Fetch the current HEAD SHA so we can tell "already reviewed at this
      // exact SHA" apart from "reviewed earlier, but new commits since".
      let headSha: string | null = null;
      try {
        headSha = await getPRHeadSha(owner, repo, pr.number);
      } catch (err) {
        logger.warn(`[POLLER] Could not fetch HEAD SHA for ${prLabel}: ${(err as Error).message}`);
      }

      // A recovery attempt suppresses only the same revision, never a newer HEAD.
      // If HEAD is unavailable, fail closed rather than risk replaying a recovery.
      if ((!headSha && [...recovering].some(key => key.startsWith(`${prLabel.toLowerCase()}:`)))
        || (headSha && recovering.has(`${prLabel.toLowerCase()}:${headSha.toLowerCase()}`))) continue;

      let pendingReport;
      try { pendingReport = headSha ? readReportOutbox(owner, repo, pr.number, headSha) : null; }
      catch (err) {
        logger.error(`[POLLER] Unsafe outbox for ${prLabel}; skipping review: ${(err as Error).message}`);
        continue;
      }
      if (!pendingReport && state.isPRReviewing(owner, repo, pr.number)) {
        logger.info(`[POLLER] Skipping in-progress: ${prLabel} - "${pr.title}"`);
        continue;
      }

      if (headSha && state.isPRReviewed(owner, repo, pr.number, headSha) && !pendingReport) {
        logger.info(`[POLLER] Skipping — already reviewed at current SHA: ${prLabel}`);
        continue;
      }

      if (state.isPRCompleted(owner, repo, pr.number)) {
        if (!headSha) {
          // Can't confirm new commits without a SHA — skip rather than
          // re-review on every poll.
          logger.info(`[POLLER] Skipping completed (HEAD SHA unavailable): ${prLabel}`);
          continue;
        }
        logger.info(`[POLLER] New commits since last review, re-reviewing: ${prLabel} - "${pr.title}"`);
      } else {
        logger.info(`[POLLER] New PR detected: ${prLabel} - "${pr.title}"`);
      }

      newPRs.push({ pr, owner, repo, headSha });
    }

    if (newPRs.length === 0) return;

    const concurrency = Math.max(1, config.reviewConcurrency);
    logger.info(`[POLLER] Reviewing ${newPRs.length} PR(s), up to ${concurrency} at a time...`);

    // Review in bounded batches so concurrent Opus subagents + clones don't
    // exhaust memory and trip PM2's max_memory_restart.
    const results: Array<{ owner: string; repo: string; pr: GitHubPRItem; outcome: RetryOutcome }> = [];
    for (let i = 0; i < newPRs.length; i += concurrency) {
      if (shouldStop()) {
        logger.info(`[POLLER] Draining; leaving ${newPRs.length - i} queued PR(s) for the next process`);
        break;
      }
      const batch: typeof newPRs = [];
      for (const candidate of newPRs.slice(i, i + concurrency)) {
        const { owner, repo, pr, headSha } = candidate;
        try {
          if (!headSha || !readReportOutbox(owner, repo, pr.number, headSha)) state.markPRReviewing(owner, repo, pr.number, headSha);
          batch.push(candidate);
        } catch (err) {
          logger.error(`[POLLER] Cannot safely start ${owner}/${repo}#${pr.number}: ${(err as Error).message}`);
        }
      }
      const batchResults = await Promise.all(
        batch.map(({ pr, owner, repo }) =>
          triggerReview(pr).then(outcome => ({ owner, repo, pr, outcome }))
        )
      );
      results.push(...batchResults);
    }

    // executeReview already records each PR's final state (verdict + headSha);
    // no extra markPRReviewed here — it would overwrite headSha and trigger
    // spurious re-reviews.
    const successes = results.filter(r => r.outcome?.success).length;
    const skipped = results.filter(r => r.outcome?.skipped).length;
    const failed = results.filter(r => r.outcome && !r.outcome.success && !r.outcome.skipped).length;
    logger.info(`[POLLER] Parallel batch done — success: ${successes}, skipped: ${skipped}, failed: ${failed}`);
  } catch (err) {
    const error = err as { message?: string; response?: { status: number; data: unknown }; stack?: string };
    logger.error(`[POLLER] Error polling assigned PRs: ${error.message}`);
    if (error.response) {
      logger.error(`[POLLER] API response: ${error.response.status} ${JSON.stringify(error.response.data)}`);
    }
  } finally {
    assignedPollInFlight = false;
  }
}

async function pollReviewCommentReplies(shouldStop: ShouldStop = () => false): Promise<void> {
  if (shouldStop()) {
    logger.info('[comment-reply-monitor] Draining; skipping reply-monitor poll');
    return;
  }
  if (!config.replyMonitorEnabled) {
    logger.debug('[comment-reply-monitor] Disabled by REPLY_MONITOR_ENABLED=false');
    return;
  }

  const state = getSharedState();
  const prs = state.getPRsForReplyMonitoring(config.replyMonitorLookbackDays);
  if (prs.length === 0) return;

  const minReplyCreatedAt = state.getReplyMonitorStartedAt();
  const botLogin = await getAuthenticatedLogin();
  if (!botLogin) {
    logger.warn('[comment-reply-monitor] Could not resolve bot login; skipping reply monitor');
    return;
  }

  logger.info(`[comment-reply-monitor] Checking review-comment replies on ${prs.length} reviewed PR(s)`);
  for (const pr of prs) {
    if (shouldStop()) {
      logger.info('[comment-reply-monitor] Draining; leaving remaining reply checks for the next process');
      return;
    }
    try {
      const comments = await listReviewComments(pr.owner, pr.repo, pr.prNumber);
      const result = await processReviewCommentReplies({
        owner: pr.owner,
        repo: pr.repo,
        prNumber: pr.prNumber,
        botLogin,
        comments,
        minReplyCreatedAt,
        isCommentReplied: (commentId) => state.isCommentReplied(commentId),
        markCommentReplied: (commentId) => state.markCommentReplied(commentId),
        isReviewThreadClosed: (rootCommentId) => state.isReviewThreadClosed(
          getReviewThreadKey(pr.owner, pr.repo, pr.prNumber, rootCommentId),
        ),
        markReviewThreadClosed: (rootCommentId, resolution) => state.markReviewThreadClosed(
          getReviewThreadKey(pr.owner, pr.repo, pr.prNumber, rootCommentId),
          resolution,
        ),
        recordReviewThreadHandoff: (rootCommentId, commentId) => state.recordReviewThreadHandoff(
          getReviewThreadKey(pr.owner, pr.repo, pr.prNumber, rootCommentId),
          commentId,
        ),
        getReviewThreadClosure: (rootCommentId) => state.getReviewThreadClosure(
          getReviewThreadKey(pr.owner, pr.repo, pr.prNumber, rootCommentId),
        ),
        reserveReviewThreadReconsideration: (rootCommentId, commentId, triggeringLogin, pendingReplyBody, pendingHeadSha, operationMarker) => state.reserveReviewThreadReconsideration(
          getReviewThreadKey(pr.owner, pr.repo, pr.prNumber, rootCommentId),
          commentId,
          triggeringLogin,
          pendingReplyBody,
          pendingHeadSha,
          operationMarker,
        ),
        markReviewThreadReconsiderationPostAttempted: (rootCommentId) => state.markReviewThreadReconsiderationPostAttempted(
          getReviewThreadKey(pr.owner, pr.repo, pr.prNumber, rootCommentId),
        ),
        completeReviewThreadReconsideration: (rootCommentId) => {
          state.completeReviewThreadReconsideration(
            getReviewThreadKey(pr.owner, pr.repo, pr.prNumber, rootCommentId),
          );
        },
        markReviewThreadReconsiderationDeliveryUnknown: (rootCommentId) => {
          state.markReviewThreadReconsiderationDeliveryUnknown(
            getReviewThreadKey(pr.owner, pr.repo, pr.prNumber, rootCommentId),
          );
        },
        cancelReviewThreadReconsideration: (rootCommentId) => {
          state.cancelReviewThreadReconsideration(
            getReviewThreadKey(pr.owner, pr.repo, pr.prNumber, rootCommentId),
          );
        },
        getReviewReplyDelivery: (humanReplyId) => state.getReviewReplyDelivery(
          getReviewReplyDeliveryKey(pr.owner, pr.repo, pr.prNumber, humanReplyId),
        ),
        reserveReviewReplyDelivery: (humanReplyId, parentCommentId, pendingReplyBody, pendingHeadSha, operationMarker) => state.reserveReviewReplyDelivery(
          getReviewReplyDeliveryKey(pr.owner, pr.repo, pr.prNumber, humanReplyId),
          humanReplyId,
          parentCommentId,
          pendingReplyBody,
          pendingHeadSha,
          operationMarker,
        ),
        markReviewReplyDeliveryPostAttempted: (humanReplyId) => state.markReviewReplyDeliveryPostAttempted(
          getReviewReplyDeliveryKey(pr.owner, pr.repo, pr.prNumber, humanReplyId),
        ),
        completeReviewReplyDelivery: (humanReplyId) => {
          state.completeReviewReplyDelivery(
            getReviewReplyDeliveryKey(pr.owner, pr.repo, pr.prNumber, humanReplyId),
          );
        },
        markReviewReplyDeliveryUnknown: (humanReplyId) => {
          state.markReviewReplyDeliveryUnknown(
            getReviewReplyDeliveryKey(pr.owner, pr.repo, pr.prNumber, humanReplyId),
          );
        },
        cancelReviewReplyDelivery: (humanReplyId) => {
          state.cancelReviewReplyDelivery(
            getReviewReplyDeliveryKey(pr.owner, pr.repo, pr.prNumber, humanReplyId),
          );
        },
        getRepositoryPermission,
        getPRHeadSha,
        judgeAndDraftReply,
        postReviewCommentReply,
        notifyReviewCommentReply: (event) => sendDiscordNotification('review_comment_reply', {
          owner: event.owner,
          repo: event.repo,
          prNumber: event.prNumber,
          prTitle: `${event.owner}/${event.repo}#${event.prNumber}`,
          commenter: event.humanReply.user?.login,
          commentId: event.humanReply.id,
          parentCommentId: event.parentComment.id,
          commentBody: event.humanReply.body,
          botReplyBody: event.botReplyBody,
          commentUrl: event.humanReply.html_url,
          replyUrl: event.botReplyUrl,
          replyAction: event.action,
        }),
        classifyAndPersistReviewLesson: (event) => archiveAndMaybeLearnFromThread(event),
      });
      if (result.candidates > 0 || result.replied > 0) {
        logger.info(
          `[comment-reply-monitor] ${pr.owner}/${pr.repo}#${pr.prNumber}: ` +
          `scanned=${result.scanned}, candidates=${result.candidates}, replied=${result.replied}, skipped=${result.skipped}`
        );
      }
    } catch (err) {
      logger.warn(`[comment-reply-monitor] Failed on ${pr.owner}/${pr.repo}#${pr.prNumber}: ${(err as Error).message}`);
    }
  }
}

async function triggerReview(pr: GitHubPRItem): Promise<RetryOutcome> {
  const repoInfo = getRepoInfo(pr);
  const prInfo: PRInfo = {
    owner: repoInfo.owner,
    repo: repoInfo.name,
    prNumber: pr.number,
    title: pr.title,
  };

  const outcome = await executeReviewWithRetry(
    prInfo,
    (p) => executeReview(p.owner, p.repo, p.prNumber)
  );

  if (outcome.success) {
    logger.info(`[POLLER] Review succeeded for PR #${pr.number}`);
  } else if (outcome.skipped) {
    logger.warn(`[POLLER] PR #${pr.number} permanently skipped after max retries`);
  } else {
    logger.warn(`[POLLER] PR #${pr.number} failed (retry ${outcome.retryCount}/3): ${outcome.error}`);
  }

  return outcome;
}

function startPolling(intervalMinutes = 5): PollingController {
  // Prune old completed entries so the state file does not grow unbounded.
  try {
    getSharedState().pruneOldEntries(config.stateRetentionDays * 24 * 60 * 60 * 1000);
  } catch (err) {
    logger.warn(`[POLLER] State prune failed: ${(err as Error).message}`);
  }

  try {
    getSharedReviewMemoryStore().pruneOldEntries(config.reviewMemoryRetentionDays * 24 * 60 * 60 * 1000);
  } catch (err) {
    logger.warn(`[POLLER] Review memory prune failed: ${(err as Error).message}`);
  }

  logger.info(`[POLLER] Starting cron job: every ${intervalMinutes} minutes`);
  const shutdown = new GracefulShutdown();
  const tick = (): void => {
    const task = shutdown.run(async () => {
      const shouldStop = (): boolean => shutdown.isDraining || isReviewDraining();
      await pollAssignedPRs(shouldStop);
      if (!shouldStop()) {
        await pollReviewCommentReplies(shouldStop);
      }
    });
    if (!task) {
      logger.info('[POLLER] Draining; ignored scheduled poll tick');
    }
  };
  const cronTask = cron.schedule(`*/${intervalMinutes} * * * *`, tick);
  tick();

  let stopPromise: Promise<GracefulShutdownResult> | undefined;
  return {
    stop(timeoutMs: number): Promise<GracefulShutdownResult> {
      if (stopPromise) return stopPromise;
      shutdown.beginDrain();
      cronTask.stop();
      logger.info(`[POLLER] Draining ${shutdown.activeCount} active poll tick(s)`);
      stopPromise = shutdown.waitForIdle(timeoutMs);
      return stopPromise;
    },
  };
}

export {
  pollAssignedPRs,
  startPolling,
};
