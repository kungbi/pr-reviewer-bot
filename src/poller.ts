import cron from 'node-cron';
import axios from 'axios';
import { executeReviewWithRetry } from './review/polling-reviewer';
import { executeReview } from './review/review-executor';
import ReviewedPRsState, { STATE_FILE } from './utils/state-manager';
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

    const state = new ReviewedPRsState(STATE_FILE);
    state.load();

    const newPRs: Array<{ pr: GitHubPRItem; owner: string; repo: string }> = [];
    for (const pr of items) {
      const { owner, name: repo } = getRepoInfo(pr);
      const prLabel = `${owner}/${repo}#${pr.number}`;

      if (state.isPRCompleted(owner, repo, pr.number)) {
        logger.info(`[POLLER] Skipping completed: ${prLabel} - "${pr.title}"`);
        continue;
      }

      if (state.isPRReviewing(owner, repo, pr.number)) {
        logger.info(`[POLLER] Skipping in-progress: ${prLabel} - "${pr.title}"`);
        continue;
      }

      logger.info(`[POLLER] New PR detected: ${prLabel} - "${pr.title}"`);
      newPRs.push({ pr, owner, repo });
    }

    if (newPRs.length === 0) return;

    for (const { owner, repo, pr } of newPRs) {
      state.markPRReviewing(owner, repo, pr.number);
    }

    logger.info(`[POLLER] Starting parallel review of ${newPRs.length} PR(s)...`);
    const reviewPromises = newPRs.map(({ pr, owner, repo }) =>
      triggerReview(pr).then(outcome => ({ owner, repo, pr, outcome }))
    );
    const results = await Promise.all(reviewPromises);

    for (const { owner, repo, pr, outcome } of results) {
      if (outcome?.success) {
        state.markPRReviewed(owner, repo, pr.number, 'completed');
      }
    }

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
  logger.info(`[POLLER] Starting cron job: every ${intervalMinutes} minutes`);
  cron.schedule(`*/${intervalMinutes} * * * *`, () => { pollAssignedPRs(); });
  pollAssignedPRs();
}

export {
  pollAssignedPRs,
  startPolling,
};
