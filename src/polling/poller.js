const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { executeReviewWithRetry } = require('../review/polling-reviewer');
const { executeReview } = require('../review/review-executor');


const GH_API = 'https://api.github.com';

/**
 * Get HTTP headers with auth token
 */
function getHeaders() {
  const token = process.env.GH_TOKEN;
  return {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
  };
}

/**
 * Search ALL repos for PRs where the bot user is requested as reviewer.
 * Uses GitHub REST API directly — no git remote needed.
 */
async function searchPRsForReviewer(limit = 100) {
  const username = 'backend-woongbi';
  const url = `${GH_API}/search/issues?q=type:pr+state:open+review-requested:${username}&per_page=${limit}`;
  const res = await axios.get(url, { headers: getHeaders() });
  return res.data.items || [];
}

const STATE_FILE = path.join(__dirname, '../../state/reviewed-prs.json');

/**
 * Load reviewed PRs from state file.
 * Returns a flat array of PR keys (e.g. ["owner/repo#1", "owner/repo#2"])
 */
function loadReviewedPRs() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf8');
      const state = JSON.parse(data);
      // Support legacy {reviewedPRs:{...}} object format and flat array format
      if (Array.isArray(state)) return state;
      if (state.reviewedPRs && typeof state.reviewedPRs === 'object') {
        return Object.keys(state.reviewedPRs);
      }
      return [];
    }
  } catch (err) {
    console.error('[ERROR] Failed to load reviewed PRs state:', err.message);
  }
  return [];
}

/**
 * Save reviewed PRs to state file as a flat array
 */
function saveReviewedPRs(prs) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(prs, null, 2));
  } catch (err) {
    console.error('[ERROR] Failed to save reviewed PRs state:', err.message);
  }
}

/**
 * Get PR key for tracking (owner/repo#number)
 */
function getPRKey(pr) {
  // pr.html_url like "https://github.com/owner/repo/pull/123"
  const url = pr.html_url || '';
  const match = url.match(/github\.com\/([^/]+\/[^/]+)/);
  const repo = match ? match[1] : 'unknown';
  return `${repo}#${pr.number}`;
}

/**
 * Get repository owner and name from PR
 */
function getRepoInfo(pr) {
  // pr.html_url like "https://github.com/owner/repo/pull/123"
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
async function pollAssignedPRs() {
  console.log('[POLLER] Checking for assigned PRs...');

  try {
    // Search ALL repos for PRs where backend-woongbi is requested as reviewer
    const itemsRaw = await searchPRsForReviewer(100);
    const items = Array.isArray(itemsRaw) ? itemsRaw : [];

    console.log(`[POLLER] Found ${items.length} PR(s) where I am requested as reviewer`);

    if (items.length === 0) {
      return;
    }

    // Load already reviewed PRs
    const reviewedPRs = loadReviewedPRs();
    const reviewedSet = new Set(reviewedPRs);

    // Check each PR — build list of PRs to review
    const newPRs = [];
    for (const pr of items) {
      const prKey = getPRKey(pr);

      if (reviewedSet.has(prKey)) {
        console.log(`[POLLER] Skipping already reviewed: ${prKey} - "${pr.title}"`);
        continue;
      }

      console.log(`[POLLER] New PR detected: ${prKey} - "${pr.title}"`);
      newPRs.push({ pr, prKey });
    }

    if (newPRs.length === 0) {
      return;
    }

    // ── Parallel review: fire all at once ──────────────────────────────────
    console.log(`[POLLER] Starting parallel review of ${newPRs.length} PR(s)...`);
    const reviewPromises = newPRs.map(({ pr, prKey }) =>
      triggerReview(pr).then(outcome => ({ prKey, outcome }))
    );
    const results = await Promise.all(reviewPromises);

    // Update state: only mark success/skipped as done
    for (const { prKey, outcome } of results) {
      if (outcome && (outcome.success || outcome.skipped)) {
        reviewedPRs.push(prKey);
      }
    }
    saveReviewedPRs(reviewedPRs);

    const successes = results.filter(r => r.outcome?.success).length;
    const skipped = results.filter(r => r.outcome?.skipped).length;
    const failed = results.filter(r => r.outcome && !r.outcome.success && !r.outcome.skipped).length;
    console.log(`[POLLER] Parallel batch done — success: ${successes}, skipped: ${skipped}, failed: ${failed}`);
  } catch (err) {
    console.error('[POLLER] Error polling assigned PRs:', err.message);
    if (err.response) {
      console.error('[POLLER] API response:', err.response.status, err.response.data);
    }
    console.error('[POLLER] Stack:', err.stack);
  }
}

/**
 * Core review execution (used by retry wrapper)
 */
async function _doReview(prInfo) {
  return await executeReview(prInfo.owner, prInfo.repo, prInfo.prNumber);
}

/**
 * Trigger review for a PR — uses retry wrapper from polling-reviewer.js
 */
async function triggerReview(pr) {
  const repoInfo = getRepoInfo(pr);
  const prInfo = {
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
function startPolling(intervalMinutes = 5) {
  const intervalCron = `*/${intervalMinutes} * * * *`;

  console.log(`[POLLER] Starting cron job: every ${intervalMinutes} minutes`);

  cron.schedule(intervalCron, () => {
    pollAssignedPRs();
  });

  // Run immediately on start
  pollAssignedPRs();
}

module.exports = {
  pollAssignedPRs,
  startPolling,
};
