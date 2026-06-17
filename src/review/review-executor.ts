/**
 * review-executor.ts
 *
 * Orchestrates PR reviews. Clones the PR (optional), spawns the Claude CLI
 * subagent with a prompt that instructs it to post inline comments directly
 * via `gh api`, then extracts a single-line verdict for state tracking.
 */


import { getPRDetails, getPRHeadSha, verifyReviewPosted } from '../github';
import { buildAnalysisPrompt } from '../review-prompt';
import { sessions_spawn } from '../utils/sessions_spawn';
import { extractVerdict } from './verdict';
import { cloneRepoForPR, cleanupClone } from './repo-cloner';
import ReviewedPRsState, { getSharedState } from '../utils/state-manager';
import logger from '../utils/logger';
import config from '../utils/config';
import { ReviewResult, ReviewVerdict, PRStatus } from '../types';

const inFlightReviews = new Set<string>();

async function executeReview(
  owner: string,
  repo: string,
  prNumber: number,
  stateOverride?: ReviewedPRsState
): Promise<ReviewResult> {
  const state = stateOverride || getSharedState();

  const startTime = Date.now();
  logger.info(`[review-executor] Starting review: ${owner}/${repo}#${prNumber}`);

  // ── 1. Skip if already reviewed or currently in-flight ───────────────────
  let headSha: string | null = null;
  try {
    headSha = await getPRHeadSha(owner, repo, prNumber);
  } catch (err) {
    logger.warn(`[review-executor] Could not fetch head SHA: ${(err as Error).message}`);
  }

  let isReReview = false;
  let previousSha: string | null = null;
  if (headSha) {
    if (state.isPRReviewed(owner, repo, prNumber, headSha)) {
      logger.info(`[review-executor] PR already reviewed at current SHA, skipping: ${owner}/${repo}#${prNumber}`);
      return { success: true, verdict: 'already_reviewed', commentPosted: false };
    }
    if (state.isPRCompleted(owner, repo, prNumber)) {
      isReReview = true;
      previousSha = state.getReviewedHeadSha(owner, repo, prNumber);
      logger.info(`[review-executor] New commits detected on ${owner}/${repo}#${prNumber}, re-reviewing (prev SHA: ${previousSha ?? 'unknown'})`);
    }
  } else if (state.isPRCompleted(owner, repo, prNumber)) {
    logger.info(`[review-executor] PR already completed (no SHA available), skipping: ${owner}/${repo}#${prNumber}`);
    return { success: true, verdict: 'already_reviewed', commentPosted: false };
  }

  const prKey = `${owner}/${repo}#${prNumber}`;
  if (inFlightReviews.has(prKey)) {
    logger.info(`[review-executor] PR review already in progress, skipping: ${prKey}`);
    return { success: true, verdict: 'already_reviewed', commentPosted: false };
  }
  inFlightReviews.add(prKey);

  try {
    // ── 2. Fetch PR details (for notifications) ──────────────────────────────
    let prTitle = `PR #${prNumber}`;
    let prUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;
    let prAuthor: string | null = null;
    let prHeadBranch: string | null = null;
    let prBaseBranch: string | null = null;
    try {
      const details = await getPRDetails(owner, repo, prNumber);
      if (details?.title)         prTitle      = details.title;
      if (details?.url)           prUrl        = details.url;
      if (details?.author?.login) prAuthor     = details.author.login;
      if (details?.headRefName)   prHeadBranch = details.headRefName;
      if (details?.baseRefName)   prBaseBranch = details.baseRefName;
    } catch (err) {
      logger.warn(`[review-executor] Could not fetch PR details: ${(err as Error).message}`);
    }

    // ── 3. Notify Discord that review has started ────────────────────────────
    try {
      const { sendReviewStartedNotification } = require('../discord-notifier');
      await sendReviewStartedNotification({
        owner, repo, prNumber,
        prTitle, prUrl, prAuthor, prHeadBranch, prBaseBranch,
      });
    } catch (err) {
      logger.warn(`[review-executor] Discord start notification failed: ${(err as Error).message}`);
    }

    // ── 4. Clone (optional) + run subagent ───────────────────────────────────
    let clonePath: string | undefined;
    if (config.prCloneEnabled) {
      const cloneResult = await cloneRepoForPR({ owner, repo, prNumber });
      if (cloneResult.ok) {
        clonePath = cloneResult.path;
        logger.info(`[review-executor] Clone ready at ${clonePath} for ${owner}/${repo}#${prNumber}`);
      } else {
        logger.warn(`[review-executor] Clone failed (${cloneResult.reason}) — falling back to gh-based review`);
      }
    }

    let reviewOutput: string;
    let subagentFailed = false;
    try {
      const prompt = buildAnalysisPrompt({ owner, repo, prNumber, clonePath, isReReview, previousSha });
      logger.info(`[review-executor] Spawning review session for ${owner}/${repo}#${prNumber}${clonePath ? ' (clone mode)' : ' (gh mode)'}`);
      reviewOutput = await sessions_spawn(prompt, clonePath ? { cwd: clonePath } : undefined);
      if (!reviewOutput || !reviewOutput.trim()) {
        throw new Error('sessions_spawn returned empty output');
      }
      const elapsed = Date.now() - startTime;
      logger.info(`[review-executor] Subagent finished in ${elapsed}ms (${reviewOutput.length} chars)`);
    } catch (err) {
      logger.error(`[review-executor] Subagent failed: ${(err as Error).message}`);
      reviewOutput = '';
      subagentFailed = true;
    } finally {
      if (clonePath) {
        await cleanupClone(clonePath);
        logger.info(`[review-executor] Clone cleaned up: ${clonePath}`);
      }
    }

    // ── 4b. Verify the review actually landed on GitHub ──────────────────────
    // A clean `claude` exit does not guarantee the subagent's
    // `gh api .../reviews` call succeeded (e.g. all inline comments rejected
    // with 422). Confirm a review by the bot exists at the current HEAD SHA.
    let reviewMissing = false;
    if (!subagentFailed && headSha) {
      try {
        const posted = await verifyReviewPosted(owner, repo, prNumber, headSha);
        if (!posted) {
          reviewMissing = true;
          logger.error(`[review-executor] Subagent exited cleanly but no review found on GitHub: ${owner}/${repo}#${prNumber}`);
        }
      } catch (err) {
        // Verification call itself failed — trust the subagent rather than
        // forcing a false failure.
        logger.warn(`[review-executor] Review verification failed, assuming posted: ${(err as Error).message}`);
      }
    }

    // ── 5. On failure: notify Discord, then throw ───────────────────────────
    // PR fallback comment is only posted by polling-reviewer when retries are
    // exhausted, so transient failures don't litter the PR with duplicate
    // "Auto-Review Failed" comments. Throwing routes the PR through
    // executeReviewWithRetry for retry handling.
    if (subagentFailed || reviewMissing) {
      const reason = subagentFailed
        ? 'Claude 서브에이전트 실행 실패'
        : '리뷰가 GitHub에 게시되지 않음';

      try {
        const { sendReviewFailedNotification } = require('../discord-notifier');
        await sendReviewFailedNotification({
          owner, repo, prNumber,
          prTitle, prAuthor, prHeadBranch, prBaseBranch,
          errorMessage: reason,
          permanentlySkipped: false,
        });
      } catch (err) {
        logger.warn(`[review-executor] Discord failure notification failed: ${(err as Error).message}`);
      }

      throw new Error(reason);
    }

    // ── 6. Extract verdict + update state ────────────────────────────────────
    const verdict: ReviewVerdict = extractVerdict(reviewOutput);
    const prStatus: PRStatus = verdict === 'already_reviewed' ? 'reviewed' : verdict;

    try {
      state.markPRReviewed(owner, repo, prNumber, prStatus, headSha);
      logger.info(`[review-executor] State updated: ${owner}/${repo}#${prNumber} → ${verdict}`);
    } catch (err) {
      logger.warn(`[review-executor] Failed to update state: ${(err as Error).message}`);
    }

    // ── 7. Notify Discord — completion ───────────────────────────────────────
    const issueList: string[] = [];
    if (verdict === 'blocked')    issueList.push('🔴 Changes requested');
    if (verdict === 'needs_work') issueList.push('🟡 Improvements suggested');
    if (verdict === 'approved')   issueList.push('✅ Approved');

    try {
      const { sendReviewCompletedNotification } = require('../discord-notifier');
      await sendReviewCompletedNotification({
        owner, repo, prNumber, prTitle, prAuthor, prHeadBranch, prBaseBranch,
        issuesFound: issueList,
      });
    } catch (err) {
      logger.warn(`[review-executor] Discord notification failed: ${(err as Error).message}`);
    }

    const totalMs = Date.now() - startTime;
    logger.info(`[review-executor] Full review completed in ${totalMs}ms for ${owner}/${repo}#${prNumber}`);
    return {
      success: true,
      verdict,
      commentPosted: true,
      timingMs: { total: totalMs },
    };
  } finally {
    inFlightReviews.delete(prKey);
  }
}

export { executeReview };
