import cron from 'node-cron';
import axios from 'axios';
import { executeReviewWithRetry } from './review/polling-reviewer';
import { executeReview } from './review/review-executor';
import { getPRHeadSha } from './github';
import { getSharedState } from './utils/state-manager';
import config from './utils/config';
import logger from './utils/logger';
import { PRInfo, RetryOutcome } from './types';

const GH_API = 'https://api.github.com';

interface GitHubPRItem {
  number: number;
  title: string;
  html_url: string;
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

async function pollAssignedPRs(): Promise<void> {
  logger.info('[POLLER] Checking for assigned PRs...');

  try {
    const itemsRaw = await searchPRsForReviewer(100);
    const items: GitHubPRItem[] = Array.isArray(itemsRaw) ? itemsRaw : [];

    logger.info(`[POLLER] Found ${items.length} PR(s) where I am requested as reviewer`);

    if (items.length === 0) return;

    const state = getSharedState();

    const newPRs: Array<{ pr: GitHubPRItem; owner: string; repo: string }> = [];
    for (const pr of items) {
      const { owner, name: repo } = getRepoInfo(pr);
      const prLabel = `${owner}/${repo}#${pr.number}`;

      if (state.isPRReviewing(owner, repo, pr.number)) {
        logger.info(`[POLLER] Skipping in-progress: ${prLabel} - "${pr.title}"`);
        continue;
      }

      // Fetch the current HEAD SHA so we can tell "already reviewed at this
      // exact SHA" apart from "reviewed earlier, but new commits since".
      let headSha: string | null = null;
      try {
        headSha = await getPRHeadSha(owner, repo, pr.number);
      } catch (err) {
        logger.warn(`[POLLER] Could not fetch HEAD SHA for ${prLabel}: ${(err as Error).message}`);
      }

      if (headSha && state.isPRReviewed(owner, repo, pr.number, headSha)) {
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

      newPRs.push({ pr, owner, repo });
    }

    if (newPRs.length === 0) return;

    for (const { owner, repo, pr } of newPRs) {
      state.markPRReviewing(owner, repo, pr.number);
    }

    const concurrency = Math.max(1, config.reviewConcurrency);
    logger.info(`[POLLER] Reviewing ${newPRs.length} PR(s), up to ${concurrency} at a time...`);

    // Review in bounded batches so concurrent Opus subagents + clones don't
    // exhaust memory and trip PM2's max_memory_restart.
    const results: Array<{ owner: string; repo: string; pr: GitHubPRItem; outcome: RetryOutcome }> = [];
    for (let i = 0; i < newPRs.length; i += concurrency) {
      const batch = newPRs.slice(i, i + concurrency);
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

function startPolling(intervalMinutes = 5): void {
  // Prune old completed entries so the state file does not grow unbounded.
  try {
    getSharedState().pruneOldEntries(config.stateRetentionDays * 24 * 60 * 60 * 1000);
  } catch (err) {
    logger.warn(`[POLLER] State prune failed: ${(err as Error).message}`);
  }

  logger.info(`[POLLER] Starting cron job: every ${intervalMinutes} minutes`);
  cron.schedule(`*/${intervalMinutes} * * * *`, () => { pollAssignedPRs(); });
  pollAssignedPRs();
}

export {
  pollAssignedPRs,
  startPolling,
};
