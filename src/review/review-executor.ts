/**
 * review-executor.ts
 *
 * Integrates the kungbi-pr-review skill with the bot workflow.
 * Fetches PR diffs, runs AI analysis via sessions_spawn,
 * posts review comments, and marks PRs as reviewed in the state file.
 */


import path from 'path';
import { getPRDiff, getPRDetails, getPRHeadSha, postComment, postInlineReview } from '../github/github';
import { buildAnalysisPrompt } from '../prompts/review-prompt';
import { buildDiffLineSet, isLineInDiff, parseFileLineRefs } from './diff-parser';
import { sessions_spawn } from '../../tools/sessions_spawn';
import ReviewedPRsState from '../utils/state-manager';
import logger from '../utils/logger';
import config from '../utils/config';
import { ReviewResult, ReviewVerdict, InlineComment, ReviewEvent } from '../types';

// Shared state instance (singleton-ish – callers may also pass their own)
const DEFAULT_STATE_PATH = path.join(process.cwd(), 'state', 'reviewed-prs.json');
const sharedState = new ReviewedPRsState(DEFAULT_STATE_PATH);
sharedState.load();

// In-flight lock: prevents concurrent duplicate reviews of the same PR
// within the same process lifetime (e.g. two poll cycles overlapping)
const inFlightReviews = new Set<string>();

/**
 * Execute a full PR review.
 */
async function executeReview(
  owner: string,
  repo: string,
  prNumber: number,
  stateOverride?: ReviewedPRsState
): Promise<ReviewResult> {
  const state = stateOverride || sharedState;

  const startTime = Date.now();
  logger.info(`[review-executor] Starting review: ${owner}/${repo}#${prNumber}`);

  // ── 1. Skip if already reviewed or currently in-flight ───────────────────
  let headSha: string | null = null;
  try {
    headSha = await getPRHeadSha(owner, repo, prNumber);
  } catch (err) {
    logger.warn(`[review-executor] Could not fetch head SHA: ${(err as Error).message}`);
  }

  if (state.isPRCompleted(owner, repo, prNumber)) {
    logger.info(`[review-executor] PR already completed, skipping: ${owner}/${repo}#${prNumber}`);
    return { success: true, verdict: 'already_reviewed', commentPosted: false };
  }

  if (state.isPRReviewed(owner, repo, prNumber, headSha)) {
    logger.info(`[review-executor] PR already reviewed at this SHA, skipping: ${owner}/${repo}#${prNumber}`);
    return { success: true, verdict: 'already_reviewed', commentPosted: false };
  }
  const prKey = `${owner}/${repo}#${prNumber}`;
  if (inFlightReviews.has(prKey)) {
    logger.info(`[review-executor] PR review already in progress, skipping: ${prKey}`);
    return { success: true, verdict: 'already_reviewed', commentPosted: false };
  }
  inFlightReviews.add(prKey);

  try {
    // ── 2. Fetch PR details (title/url/author) ───────────────────────────────
    let prTitle = `PR #${prNumber}`;
    let prUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;
    let prAuthor: string | null = null;
    let prHeadBranch: string | null = null;
    let prBaseBranch: string | null = null;
    try {
      const details = await getPRDetails(owner, repo, prNumber);
      if (details && details.title)         prTitle      = details.title;
      if (details && details.url)           prUrl        = details.url;
      if (details && details.author?.login) prAuthor     = details.author.login;
      if (details && details.headRefName)   prHeadBranch = details.headRefName;
      if (details && details.baseRefName)   prBaseBranch = details.baseRefName;
    } catch (err) {
      logger.warn(`[review-executor] Could not fetch PR details: ${(err as Error).message}`);
    }

    // ── 3. Notify Discord that review has started ────────────────────────────
    try {
      const { sendReviewStartedNotification } = require('../notification/discord-notifier');
      await sendReviewStartedNotification({
        owner, repo, prNumber,
        prTitle, prUrl, prAuthor, prHeadBranch, prBaseBranch,
      });
    } catch (err) {
      logger.warn(`[review-executor] Discord start notification failed: ${(err as Error).message}`);
    }

    // ── 4. Fetch PR diff ──────────────────────────────────────────────────────
    let diff: string;
    try {
      diff = await getPRDiff(owner, repo, prNumber);
      if (!diff || !diff.trim()) {
        logger.warn(`[review-executor] Empty diff for ${owner}/${repo}#${prNumber}`);
        diff = '(no diff available – PR may have no file changes)';
      }
    } catch (err) {
      logger.error(`[review-executor] Failed to fetch diff: ${(err as Error).message}`);
      return { success: false, verdict: 'error', commentPosted: false, error: `diff fetch failed: ${(err as Error).message}` };
    }

    // ── 4. Build prompt & run AI analysis ────────────────────────────────────
    const prompt = buildAnalysisPrompt({ owner, repo, prNumber, prTitle, prUrl, diff });

    let reviewReport: string;
    try {
      logger.info(`[review-executor] Spawning review session for ${owner}/${repo}#${prNumber}`);
      reviewReport = await sessions_spawn(prompt);
      if (!reviewReport || !reviewReport.trim()) {
        throw new Error('sessions_spawn returned empty output');
      }
      const elapsed = Date.now() - startTime;
      logger.info(`[review-executor] Review analysis complete in ${elapsed}ms (${reviewReport.length} chars)`);
    } catch (err) {
      logger.error(`[review-executor] AI analysis failed: ${(err as Error).message}`);
      // Post a fallback comment so the PR doesn't silently go unreviewed
      reviewReport = `🕷️ **Auto-Review Failed**\n\nCould not complete AI analysis for #${prNumber}.\nError: ${(err as Error).message}\n\nPlease review manually.`;
    }

    // ── 5. Post inline review ────────────────────────────────────────────────

    const diffLineSet = buildDiffLineSet(diff);
    const refs = parseFileLineRefs(reviewReport);

    const inlineComments: InlineComment[] = [];
    let blockers = 0, important = 0, minor = 0;
    for (const ref of refs) {
      if (isLineInDiff(diffLineSet, ref.file, ref.line)) {
        inlineComments.push({
          path: ref.file,
          line: ref.line,
          side: 'RIGHT',
          body: (ref.context || `Issue at line ${ref.line}`) + '\n\n---\n*— ${config.botName} Auto-Review*',
        });
        if (ref.severity === 'blocker')       blockers++;
        else if (ref.severity === 'important') important++;
        else                                   minor++;
      }
    }

    // Determine review event from actual issue counts
    let reviewEvent: ReviewEvent = 'COMMENT';
    if (blockers === 0 && important === 0)  reviewEvent = 'APPROVE';
    else if (blockers > 0)                  reviewEvent = 'REQUEST_CHANGES';
    else                                    reviewEvent = 'COMMENT';

    const issueCount = (blockers > 0 ? `🔴 ${blockers} blocker` + (blockers > 1 ? 's' : '') : '') +
      (blockers > 0 && important > 0 ? ' · ' : '') +
      (important > 0 ? `🟡 ${important} important` : '') +
      (minor > 0 && (blockers > 0 || important > 0) ? ' · ' : '') +
      (minor > 0 ? `🟢 ${minor} minor` : '') || '✅ 리뷰 완료';

    const reviewBody = [
      `**${config.botName} Auto-Review** | ${owner}/${repo}#${prNumber}`,
      `**${issueCount}**`,
    ].filter(Boolean).join('\n');

    let commentPosted = false;
    try {
      if (inlineComments.length > 0) {
        await postInlineReview(owner, repo, prNumber, headSha!, reviewBody, reviewEvent, inlineComments);
        logger.info(`[review-executor] Inline review posted (${inlineComments.length} comments) to ${owner}/${repo}#${prNumber}`);
      } else {
        await postComment(owner, repo, prNumber, reviewBody + `\n\n---\n*— ${config.botName}*`);
        logger.info(`[review-executor] No inline positions found; posted single comment to ${owner}/${repo}#${prNumber}`);
      }
      commentPosted = true;
    } catch (err) {
      logger.error(`[review-executor] Failed to post review: ${(err as Error).message}`);
    }

    // ── 6. Determine verdict from actual inline comment counts ───────────────
    let verdict: ReviewVerdict = 'reviewed';
    if (blockers > 0)       verdict = 'blocked';
    else if (important > 0) verdict = 'needs_work';
    else                    verdict = 'approved';

    // ── 7. Mark PR as reviewed in state file ────────────────────────────────
    try {
      state.markPRReviewed(owner, repo, prNumber, verdict, headSha);
      logger.info(`[review-executor] State updated: ${owner}/${repo}#${prNumber} → ${verdict}`);
    } catch (err) {
      logger.warn(`[review-executor] Failed to update state: ${(err as Error).message}`);
    }

    // ── 8. Send Discord notification ─────────────────────────────────────────
    const issueList: string[] = [];
    if (blockers  > 0) issueList.push(`🔴 ${blockers} blocker(s)`);
    if (important > 0) issueList.push(`🟡 ${important} important issue(s)`);
    if (minor     > 0) issueList.push(`🟢 ${minor} minor issue(s)`);

    try {
      const { sendReviewCompletedNotification } = require('../notification/discord-notifier');
      await sendReviewCompletedNotification({
        owner, repo, prNumber, prTitle, prAuthor, prHeadBranch, prBaseBranch,
        issuesFound: issueList,
      });
    } catch (err) {
      logger.warn(`[review-executor] Discord notification failed: ${(err as Error).message}`);
    }

    const totalMs = Date.now() - startTime;
    logger.info(`[review-executor] Full review completed in ${totalMs}ms for ${owner}/${repo}#${prNumber}`);
    return { success: true, verdict, commentPosted, timingMs: { total: totalMs } };
  } finally {
    inFlightReviews.delete(prKey);
  }
}

export { executeReview };
