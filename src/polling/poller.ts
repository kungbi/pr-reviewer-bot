import cron from 'node-cron';
import axios from 'axios';
import path from 'path';
import { executeReviewWithRetry } from '../review/polling-reviewer';
import { executeReview } from '../review/review-executor';
import ReviewedPRsState from '../utils/state-manager';
import { PRInfo, RetryOutcome, ReviewResult } from '../types';

function loadEnv(): void {
  require('dotenv').config({ path: path.join(process.cwd(), '.env') });
}

const GH_API = 'https://api.github.com';
const STATE_FILE = path.join(process.cwd(), 'state/reviewed-prs.json');

interface GitHubPRItem {
  number: number;
  title: string;
  html_url: string;
}

/**
 * Get HTTP headers with auth token
 */
function getHeaders(): Record<string, string> {
  const token = process.env.GH_TOKEN;
  return {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
  };
}

/**
 * Search ALL repos for PRs where the bot user is requested as reviewer.
 */
async function searchPRsForReviewer(limit = 100): Promise<GitHubPRItem[]> {
  const username = process.env.GH_USERNAME;
  const url = `${GH_API}/search/issues?q=type:pr+state:open+review-requested:${username}&per_page=${limit}`;
  const res = await axios.get<{ items: GitHubPRItem[] }>(url, { headers: getHeaders() });
  return res.data.items || [];
}

/**
 * Get repository owner and name from PR
 */
function getRepoInfo(pr: GitHubPRItem): { owner: string; name: string } {
  const url = pr.html_url || '';
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  return {
    owner: match ? match[1] : 'unknown',
    name: match ? match[2] : 'unknown',
  };
}

/**
 * Poll for PRs assigned to the bot user
 */
async function pollAssignedPRs(): Promise<void> {
  loadEnv();
  console.log('[POLLER] Checking for assigned PRs...');

  try {
    const itemsRaw = await searchPRsForReviewer(100);
    const items: GitHubPRItem[] = Array.isArray(itemsRaw) ? itemsRaw : [];

    console.log(`[POLLER] Found ${items.length} PR(s) where I am requested as reviewer`);

    if (items.length === 0) {
      return;
    }

    const state = new ReviewedPRsState(STATE_FILE);
    state.load();

    const newPRs: Array<{ pr: GitHubPRItem; owner: string; repo: string }> = [];
    for (const pr of items) {
      const { owner, name: repo } = getRepoInfo(pr);
      const prLabel = `${owner}/${repo}#${pr.number}`;

      if (state.isPRCompleted(owner, repo, pr.number)) {
        console.log(`[POLLER] Skipping completed: ${prLabel} - "${pr.title}"`);
        continue;
      }

      if (state.isPRReviewing(owner, repo, pr.number)) {
        console.log(`[POLLER] Skipping in-progress: ${prLabel} - "${pr.title}"`);
        continue;
      }

      console.log(`[POLLER] New PR detected: ${prLabel} - "${pr.title}"`);
      newPRs.push({ pr, owner, repo });
    }

    if (newPRs.length === 0) {
      return;
    }

    // ── Mark all as 'reviewing' BEFORE starting — prevents duplicate reviews across cron cycles
    for (const { owner, repo, pr } of newPRs) {
      state.markPRReviewing(owner, repo, pr.number);
    }

    // ── Parallel review: fire all at once ──────────────────────────────────
    console.log(`[POLLER] Starting parallel review of ${newPRs.length} PR(s)...`);
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
    console.log(`[POLLER] Parallel batch done — success: ${successes}, skipped: ${skipped}, failed: ${failed}`);
  } catch (err) {
    const error = err as { message?: string; response?: { status: number; data: unknown }; stack?: string };
    console.error('[POLLER] Error polling assigned PRs:', error.message);
    if (error.response) {
      console.error('[POLLER] API response:', error.response.status, error.response.data);
    }
    console.error('[POLLER] Stack:', error.stack);
  }
}

/**
 * Core review execution (used by retry wrapper)
 */
async function _doReview(prInfo: PRInfo): Promise<ReviewResult> {
  return await executeReview(prInfo.owner, prInfo.repo, prInfo.prNumber);
}

/**
 * Trigger review for a PR — uses retry wrapper from polling-reviewer.ts
 */
async function triggerReview(pr: GitHubPRItem): Promise<RetryOutcome> {
  const repoInfo = getRepoInfo(pr);
  const prInfo: PRInfo = {
    owner: repoInfo.owner,
    repo: repoInfo.name,
    prNumber: pr.number,
    title: pr.title,
  };

  const outcome = await executeReviewWithRetry(prInfo, _doReview);

  if (outcome.success) {
    console.log(`[POLLER] Review succeeded for PR #${pr.number}`);
  } else if (outcome.skipped) {
    console.warn(`[POLLER] PR #${pr.number} permanently skipped after max retries`);
  } else {
    console.warn(`[POLLER] PR #${pr.number} failed (retry ${outcome.retryCount}/3): ${outcome.error}`);
  }

  return outcome;
}

/**
 * Start polling at specified interval (in minutes)
 */
function startPolling(intervalMinutes = 5): void {
  const intervalCron = `*/${intervalMinutes} * * * *`;

  console.log(`[POLLER] Starting cron job: every ${intervalMinutes} minutes`);

  cron.schedule(intervalCron, () => {
    pollAssignedPRs();
  });

  // Run immediately on start
  pollAssignedPRs();
}

export {
  pollAssignedPRs,
  startPolling,
  loadEnv,
};
