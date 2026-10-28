/**
 * review-executor.ts
 *
 * Orchestrates PR reviews. Clones the PR (optional), creates a non-posting
 * candidate draft, runs it through a fresh independent verification session,
 * and only then publishes the verified output through the GitHub client.
 */


import {
  getPRDetails,
  getPRDiff,
  getPRHeadSha,
  listReviewThreads,
  postInlineReview,
  reconcileAttemptedReviewPublication,
  postReviewCommentReply,
  verifyReviewPosted,
} from '../github';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { sessions_spawn, ModelCapacityError } from '../utils/sessions_spawn';
import { shouldUseLocalClone } from '../utils/agent-command';
import { cloneRepoForPR, cleanupClone } from './repo-cloner';
import { getSharedRepositoryCache, RepositoryCache } from './repository-cache';
import { getReviewMemoryContext } from '../review-memory/review-memory-service';
import { getReviewSeveritySummary, getReviewVerdict, prepareReviewForPosting, ReviewDraft } from './review-draft';
import { publishVerifiedDraft } from './review-publisher';
import { publicationErrorDiagnostic, publicationDiagnosticText } from './publication-error-diagnostic';
import { runReviewVerificationGate } from './review-verification-gate';
import { buildReviewReport, extractReviewDiffChange } from './review-report-builder';
import { validateReviewReportMetadata } from './review-report';
import { renderReviewReportHtml } from './review-report-renderer';
import { storeReviewReportHtml } from './review-report-store';
import { readReportOutbox, writeReportOutbox, deleteReportOutbox, snapshotReport, validateReportSnapshot, ReportOutboxEntry, ReportPublicationAmbiguousError, ReportRecoveryError } from './review-report-outbox';
import { runReviewTestRunner, ReviewTestRunnerResult } from './review-test-runner';
import ReviewedPRsState, { getSharedState } from '../utils/state-manager';
import { GracefulShutdown, GracefulShutdownResult } from '../utils/graceful-shutdown';
import logger from '../utils/logger';
import config from '../utils/config';
import { PRDetails, ReviewResult, ReviewVerdict, PRStatus } from '../types';

const inFlightReviews = new Set<string>();
const reviewShutdown = new GracefulShutdown();
const FULL_COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

function withPublicationDiagnostic(error: Error, original: unknown, inspectionError?: unknown): Error {
  const cause = publicationErrorDiagnostic(original);
  error.message += `; original failure: ${publicationDiagnosticText(cause)}`;
  Object.defineProperty(error, 'cause', { value: cause, configurable: true });
  if (inspectionError !== undefined) {
    const diagnostic = publicationErrorDiagnostic(inspectionError);
    error.message += `; durable state inspection failed: ${publicationDiagnosticText(diagnostic)}`;
    Object.defineProperty(error, 'stateInspectionError', { value: diagnostic });
  }
  return error;
}

function publicationFailure(entry: ReportOutboxEntry, state: ReviewedPRsState, original: unknown): Error {
  try {
    const durable = readReportOutbox(entry.owner, entry.repo, entry.prNumber, entry.headSha);
    const publication = state.getDurableReviewPublication(`${entry.owner}/${entry.repo}#${entry.prNumber}:${entry.headSha}`);
    if (durable?.publicationIntent === 'unattempted') {
      const posting = prepareReviewForPosting(durable.draft);
      const digest = createHash('sha256').update(JSON.stringify({ owner: entry.owner, repo: entry.repo, prNumber: entry.prNumber, headSha: entry.headSha, body: posting.body, comments: posting.comments })).digest('hex').slice(0, 24);
      const marker = `<!-- pr-reviewer-bot:review:${digest} -->`;
      // Match recovery's exact reservation contract. Never use in-memory state,
      // an error's wording/status, or a failed inspection as proof of no POST.
      const unattempted = !publication || (posting.replies.length === 0
        && publication.status === 'pending' && publication.postAttempted === false
        && publication.owner === entry.owner && publication.repo === entry.repo
        && publication.prNumber === entry.prNumber && publication.headSha === entry.headSha
        && publication.operationMarker === marker
        && ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(publication.pendingEvent ?? '')
        && publication.pendingBody === `${marker}\n${posting.body}`
        && JSON.stringify(publication.pendingComments) === JSON.stringify(posting.comments));
      if (unattempted) return withPublicationDiagnostic(
        new ReportRecoveryError('Publication failed before a confirmed write; safe recovery will retry'), original,
      );
    }
  } catch (inspectionError) {
    // Preserve both faults without relaxing duplicate-publication protection.
    return withPublicationDiagnostic(new ReportPublicationAmbiguousError(), original, inspectionError);
  }
  return withPublicationDiagnostic(new ReportPublicationAmbiguousError(), original);
}

function normalizedCommitSha(value: unknown): string | null {
  return typeof value === 'string' && FULL_COMMIT_SHA.test(value) ? value.toLowerCase() : null;
}

function validatePinnedReportMetadata(owner: string, repo: string, prNumber: number, details: PRDetails): void {
  validateReviewReportMetadata({
    owner, repository: repo, pullRequestNumber: prNumber,
    title: details.title, baseRef: details.baseRefName, baseSha: details.baseSha,
    headRef: details.headRefName, headSha: details.headSha, generatedAt: new Date().toISOString(),
  });
}

function commitShaMatches(expected: string, actual: unknown): boolean {
  const expectedNormalized = normalizedCommitSha(expected);
  const actualNormalized = normalizedCommitSha(actual);
  return expectedNormalized !== null && actualNormalized !== null
    ? expectedNormalized === actualNormalized
    : expected === actual;
}

function readLocalCheckoutHeadSha(checkoutPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: checkoutPath,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: '/dev/null',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(normalizedCommitSha(String(stdout).trim()));
    });
  });
}

function isLocalCheckoutClean(checkoutPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('git', ['status', '--porcelain', '--untracked-files=all', '--ignored=matching'], {
      cwd: checkoutPath,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: '/dev/null',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    }, (error, stdout) => {
      resolve(!error && String(stdout).trim() === '');
    });
  });
}

function blockedTestResult(reason: string): ReviewTestRunnerResult {
  return {
    status: 'blocked',
    reason,
    install: { status: 'not_run', reason: 'Blocked before npm install.' },
    test: { status: 'not_run', reason: 'Blocked before the test command.' },
  };
}

async function buildOutboxReport(entry: ReportOutboxEntry, clonePath?: string): Promise<string> {
  const snapshot = validateReportSnapshot(entry);
  if (snapshot) return renderReviewReportHtml(snapshot);
  const { owner, repo, prNumber } = entry;
  const pinnedHeadSha = normalizedCommitSha(entry.details?.headSha);
  const pinnedBaseSha = normalizedCommitSha(entry.details?.baseSha);
  if (!entry.details || !pinnedHeadSha || !pinnedBaseSha
    || !entry.details.headRefName || !entry.details.baseRefName
    || pinnedHeadSha !== normalizedCommitSha(entry.headSha)) {
    throw new Error('authoritative report metadata is incomplete or differs from the COMMENT head');
  }

  const diff = entry.diff ?? await getPRDiff(owner, repo, prNumber);
  extractReviewDiffChange(diff, owner, repo, prNumber);
  const latestDetails = entry.diff === undefined ? await getPRDetails(owner, repo, prNumber) : entry.details;
  if (normalizedCommitSha(latestDetails.headSha) !== pinnedHeadSha
    || normalizedCommitSha(latestDetails.baseSha) !== pinnedBaseSha
    || latestDetails.headRefName !== entry.details.headRefName
    || latestDetails.baseRefName !== entry.details.baseRefName) {
    throw new Error('PR base/head changed while collecting report evidence');
  }

  let testResult = blockedTestResult(
    'No verified local checkout matched the pinned PR head; the isolated test command was not run.',
  );
  if (clonePath) {
    let localHeadSha: string | null = null;
    try {
      localHeadSha = await readLocalCheckoutHeadSha(clonePath);
    } catch {
      localHeadSha = null;
    }
    let checkoutClean = false;
    if (localHeadSha === pinnedHeadSha) {
      try {
        checkoutClean = await isLocalCheckoutClean(clonePath);
      } catch {
        checkoutClean = false;
      }
    }
    if (!localHeadSha || localHeadSha !== pinnedHeadSha || !checkoutClean) {
      testResult = blockedTestResult(
        'The local checkout no longer matched the pinned PR head or contains working-tree changes; the isolated test command was not run.',
      );
    } else {
      try {
        testResult = await runReviewTestRunner(clonePath, { trustedNodeImages: config.trustedNodeImages });
      } catch {
        testResult = blockedTestResult(
          'The isolated test runner could not complete preflight; no host test command was run.',
        );
      }
    }
  }

  // Bind public test wording to the same authoritative result persisted in the
  // private report. Do not alter legacy outbox bodies/operation identities.
  if (entry.draft.publicSummary) {
    entry.draft.testExecutionStatus = testResult.status;
  }
  const report = buildReviewReport({
    owner,
    repository: repo,
    pullRequestNumber: prNumber,
    title: entry.details.title,
    baseRef: entry.details.baseRefName,
    baseSha: pinnedBaseSha,
    headRef: entry.details.headRefName,
    headSha: pinnedHeadSha,
    diff,
    draft: entry.draft,
    testResult,
  });
  if (entry.diff !== undefined) snapshotReport(entry, report);
  return renderReviewReportHtml(report);
}

function storeOutboxReport(entry: ReportOutboxEntry, html: string): void {
  storeReviewReportHtml({
    owner: entry.owner,
    repository: entry.repo,
    pullRequestNumber: entry.prNumber,
    headSha: entry.headSha,
    html,
  });
}

async function executeReviewInternal(
  owner: string,
  repo: string,
  prNumber: number,
  stateOverride?: ReviewedPRsState,
  recoveryHeadSha?: string,
): Promise<ReviewResult> {
  const state = stateOverride || getSharedState();

  const startTime = Date.now();
  logger.info(`[review-executor] Starting review: ${owner}/${repo}#${prNumber}`);

  const prKey = `${owner}/${repo}#${prNumber}`;
  if (inFlightReviews.has(prKey)) return { success: true, verdict: 'already_reviewed', commentPosted: false };
  inFlightReviews.add(prKey);
  try {
  // ── 1. Skip if already reviewed or currently in-flight ───────────────────
  let prDetails: PRDetails | null = null;
  try {
    prDetails = await getPRDetails(owner, repo, prNumber);
  } catch (err) {
    logger.warn(`[review-executor] Could not fetch authoritative PR details: ${(err as Error).message}`);
  }

  let headSha = recoveryHeadSha ?? normalizedCommitSha(prDetails?.headSha);
  if (!headSha) {
    try {
      const fallbackHeadSha = await getPRHeadSha(owner, repo, prNumber);
      if (typeof fallbackHeadSha === 'string' && fallbackHeadSha.trim() !== '') headSha = fallbackHeadSha;
    } catch (err) {
      logger.warn(`[review-executor] Could not fetch fallback head SHA: ${(err as Error).message}`);
    }
  }

  // Only a provably unattempted publication may write during recovery.
  let pendingReport;
  try { pendingReport = headSha ? readReportOutbox(owner, repo, prNumber, headSha) : null; }
  catch (err) { throw new ReportRecoveryError(`unsafe report outbox: ${(err as Error).message}`); }
  if (recoveryHeadSha && !pendingReport) throw new ReportRecoveryError('outbox record disappeared');
  if (pendingReport) {
    const pendingSha = pendingReport.headSha;
    if (pendingReport.status !== 'published') {
      const posting = prepareReviewForPosting(pendingReport.draft);
      let publication;
      try {
        publication = state.getDurableReviewPublication(`${owner}/${repo}#${prNumber}:${headSha}`);
      } catch (err) {
        throw withPublicationDiagnostic(new ReportPublicationAmbiguousError(), err);
      }
      const digest = createHash('sha256').update(JSON.stringify({ owner, repo, prNumber, headSha, body: posting.body, comments: posting.comments })).digest('hex').slice(0, 24);
      if ((pendingReport.publicationIntent !== undefined && pendingReport.publicationIntent !== 'unattempted' && pendingReport.publicationIntent !== 'attempted')
        || (pendingReport.publicationIntent === 'unattempted' && publication && posting.replies.length !== 0)
        || (pendingReport.publicationIntent === 'attempted' && !publication)
        || (posting.replies.length !== 0 && pendingReport.publicationIntent !== 'unattempted') || (publication && (
        publication.owner !== owner || publication.repo !== repo || publication.prNumber !== prNumber
        || publication.headSha !== headSha || publication.operationMarker !== `<!-- pr-reviewer-bot:review:${digest} -->`))) {
        throw new ReportPublicationAmbiguousError();
      }
      if (!publication || (publication.status === 'pending' && publication.postAttempted === false)) {
        if (publication && (!['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(publication.pendingEvent ?? '')
          || publication.pendingBody !== `${publication.operationMarker}\n${posting.body}`
          || JSON.stringify(publication.pendingComments) !== JSON.stringify(posting.comments))) {
          throw new ReportPublicationAmbiguousError();
        }
        // The formal POST is always preceded by a durable attempt reservation.
        // Reply-free drafts therefore have no other possible write boundary.
        if (!pendingReport.details || !normalizedCommitSha(pendingReport.details.baseSha)
          || !normalizedCommitSha(pendingReport.details.headSha)
          || normalizedCommitSha(pendingReport.details.headSha) !== normalizedCommitSha(headSha)
          || !pendingReport.details.baseRefName || !pendingReport.details.headRefName
          || !prDetails || normalizedCommitSha(prDetails.headSha) !== normalizedCommitSha(pendingReport.details.headSha)
          || normalizedCommitSha(prDetails.baseSha) !== normalizedCommitSha(pendingReport.details.baseSha)
          || prDetails.headRefName !== pendingReport.details.headRefName
          || prDetails.baseRefName !== pendingReport.details.baseRefName) {
          throw new ReportRecoveryError('authoritative report metadata is incomplete');
        }
        try { validatePinnedReportMetadata(owner, repo, prNumber, pendingReport.details); }
        catch { throw new ReportRecoveryError('authoritative report metadata is incomplete'); }
        try {
          if (pendingReport.diff === undefined) {
            pendingReport.diff = await getPRDiff(owner, repo, prNumber);
            extractReviewDiffChange(pendingReport.diff, owner, repo, prNumber);
          }
          await buildOutboxReport(pendingReport);
        } catch (err) { throw new ReportRecoveryError(`report preflight failed: ${(err as Error).message}`); }
        try {
          const current = await getPRDetails(owner, repo, prNumber);
          if (!current || normalizedCommitSha(current.headSha) !== normalizedCommitSha(pendingReport.details.headSha)
            || normalizedCommitSha(current.baseSha) !== normalizedCommitSha(pendingReport.details.baseSha)
            || current.headRefName !== pendingReport.details.headRefName || current.baseRefName !== pendingReport.details.baseRefName) throw new Error('revisions changed');
        } catch { throw new ReportRecoveryError('could not confirm PR revisions before recovery publication'); }
        try { writeReportOutbox(pendingReport); }
        catch (err) { throw new ReportRecoveryError(`could not persist report snapshot: ${(err as Error).message}`); }
        try {
          await publishVerifiedDraft({ owner, repo, prNumber, headSha: headSha as string,
            prAuthor: pendingReport.details.author?.login ?? null, state, draft: pendingReport.draft,
            beforeFirstReply: () => {
              pendingReport.publicationIntent = 'attempted';
              writeReportOutbox(pendingReport);
            },
            postInlineReview, postReviewCommentReply });
        } catch (err) {
          throw publicationFailure(pendingReport, state, err);
        }
      } else if (publication.status !== 'completed') {
        try {
          if (!publication.postAttempted || !await reconcileAttemptedReviewPublication(owner, repo, prNumber, pendingSha, state)) throw new ReportPublicationAmbiguousError();
        } catch {
          throw new ReportPublicationAmbiguousError();
        }
      }
      pendingReport.status = 'published';
      try {
        writeReportOutbox(pendingReport);
      } catch (err) {
        throw new ReportRecoveryError((err as Error).message);
      }
    }
    try {
      storeOutboxReport(pendingReport, await buildOutboxReport(pendingReport));
      // The PR-wide in-flight guard excludes a concurrent executor. A persisted
      // reviewing lock may be left by a crash and must not block recovery.
      if (!prDetails || !normalizedCommitSha(prDetails.headSha)) {
        throw new Error('cannot establish current HEAD before finalizing report recovery');
      }
      if (commitShaMatches(pendingSha, prDetails.headSha)) {
        const completedSha = state.getReviewedHeadSha(owner, repo, prNumber);
        if (state.isPRCompleted(owner, repo, prNumber) && completedSha
          && !commitShaMatches(pendingSha, completedSha)) {
          // Without revision ordering, preserve both the completed state and
          // the outbox tombstone to prevent reposting this same HEAD.
          return { success: true, verdict: 'already_reviewed', commentPosted: false };
        }
        state.markPRReviewed(owner, repo, prNumber, 'awaiting_human_review', headSha);
      } else {
        state.releaseReviewingAtRevision(owner, repo, prNumber, pendingSha);
      }
      deleteReportOutbox(pendingReport);
    } catch (err) {
      logger.warn(`[review-executor] Report recovery failed: ${(err as Error).message}`);
      throw new ReportRecoveryError((err as Error).message);
    }
    return { success: true, verdict: 'already_reviewed', commentPosted: false };
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

    // ── 2. Reuse the same authoritative PR snapshot for review + report ──────
    let prTitle = `PR #${prNumber}`;
    let prUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;
    let prAuthor: string | null = null;
    let prHeadBranch: string | null = null;
    let prBaseBranch: string | null = null;
    if (prDetails?.title)         prTitle      = prDetails.title;
    if (prDetails?.url)           prUrl        = prDetails.url;
    if (prDetails?.author?.login) prAuthor     = prDetails.author.login;
    if (prDetails?.headRefName)   prHeadBranch = prDetails.headRefName;
    if (prDetails?.baseRefName)   prBaseBranch = prDetails.baseRefName;

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
    let repositoryCache: RepositoryCache | undefined;
    let cachedWorkspace = false;
    let localReportStatus: 'generated' | 'unavailable' = 'unavailable';
    if (config.prCloneEnabled && shouldUseLocalClone(config.reviewAgent)) {
      let cloneResult;
      if (config.repositoryCacheEnabled) {
        repositoryCache = getSharedRepositoryCache();
        cloneResult = await repositoryCache.preparePRWorkspace({ owner, repo, prNumber });
        cachedWorkspace = cloneResult.ok;
        if (!cloneResult.ok) {
          logger.warn(`[review-executor] Cached worktree failed (${cloneResult.reason}) — falling back to one-off clone`);
        }
      }
      if (!cloneResult?.ok) {
        cloneResult = await cloneRepoForPR({ owner, repo, prNumber });
      }
      if (cloneResult.ok) {
        if (!headSha || !commitShaMatches(headSha, cloneResult.headSha)) {
          logger.warn('[review-executor] Local checkout does not match the pinned PR head; skipping clone-mode review and tests');
          if (cachedWorkspace && repositoryCache) {
            await repositoryCache.cleanupPRWorkspace(cloneResult.path);
          } else {
            await cleanupClone(cloneResult.path);
          }
          cachedWorkspace = false;
        } else {
          clonePath = cloneResult.path;
          logger.info(`[review-executor] Clone ready at ${clonePath} for ${owner}/${repo}#${prNumber}`);
        }
      } else {
        logger.warn(`[review-executor] Clone failed (${cloneResult.reason}) — falling back to gh-based review`);
      }
    } else if (config.prCloneEnabled) {
      logger.info('[review-executor] Skipping local clone: Hermes reviews through its remote GitHub read path');
    }

    let verifiedDraft: ReviewDraft | null = null;
    let outboxEntry: ReportOutboxEntry | null = null;
    let preflightHtml: string | null = null;
    let subagentFailed = false;
    let subagentError: Error | null = null;
    try {
      if (!headSha) {
        headSha = await getPRHeadSha(owner, repo, prNumber);
      }
      if (!headSha) {
        throw new Error('Could not resolve current PR head SHA for verified review posting');
      }

      const reviewThreads = await listReviewThreads(owner, repo, prNumber);

      let reviewMemory;
      try {
        reviewMemory = getReviewMemoryContext({ owner, repo, limit: config.reviewMemoryMaxLessons });
        const repoLessonCount = reviewMemory.lessons.length;
        const wikiSource = reviewMemory.organizationWiki?.sourcePath;
        if (repoLessonCount > 0 || wikiSource) {
          logger.info(
            `[review-memory] Injecting repo=${repoLessonCount} lesson(s), organizationWiki=${wikiSource ?? 'none'} for ${owner}/${repo}#${prNumber}`,
          );
        }
      } catch (err) {
        logger.warn(`[review-memory] Failed to load context for ${owner}/${repo}#${prNumber}: ${(err as Error).message}`);
      }

      logger.info(`[review-executor] Starting draft + independent verification gate for ${owner}/${repo}#${prNumber}${clonePath ? ' (clone mode)' : ' (gh mode)'}`);
      verifiedDraft = await runReviewVerificationGate({
        owner,
        repo,
        prNumber,
        clonePath,
        isReReview,
        previousSha,
        reviewMemory,
        reviewThreads,
        baseBranch: prBaseBranch ?? undefined,
        repositoryCatalog: cachedWorkspace ? repositoryCache?.getCatalog() : undefined,
        repositoryCatalogPath: cachedWorkspace ? repositoryCache?.getCatalogPath() : undefined,
        refreshSelectedRepositories: cachedWorkspace && repositoryCache
          ? (fullNames) => repositoryCache!.refreshRepositories(fullNames)
          : undefined,
        spawn: sessions_spawn,
        publish: async (draft) => {
          if (!prDetails || !normalizedCommitSha(prDetails.headSha) || !normalizedCommitSha(prDetails.baseSha)
            || normalizedCommitSha(prDetails.headSha) !== normalizedCommitSha(headSha)
            || !prDetails.headRefName || !prDetails.baseRefName) {
            throw new ReportRecoveryError('authoritative report metadata is incomplete or differs from the review head');
          }
          try { validatePinnedReportMetadata(owner, repo, prNumber, prDetails); }
          catch { throw new ReportRecoveryError('authoritative report metadata is incomplete'); }
          let diff: string;
          try {
            diff = await getPRDiff(owner, repo, prNumber);
            extractReviewDiffChange(diff, owner, repo, prNumber);
          } catch (err) { throw new ReportRecoveryError(`diff preflight failed: ${(err as Error).message}`); }
          const prepared: ReportOutboxEntry = { owner, repo, prNumber, headSha: headSha as string, details: prDetails, draft, diff, status: 'prepared', publicationIntent: 'unattempted' };
          try { preflightHtml = await buildOutboxReport(prepared, clonePath); }
          catch (err) { throw new ReportRecoveryError(`report preflight failed: ${(err as Error).message}`); }
          try {
            const current = await getPRDetails(owner, repo, prNumber);
            if (!current || normalizedCommitSha(current.headSha) !== normalizedCommitSha(prDetails.headSha)
              || normalizedCommitSha(current.baseSha) !== normalizedCommitSha(prDetails.baseSha)
              || current.headRefName !== prDetails.headRefName || current.baseRefName !== prDetails.baseRefName) throw new Error('revisions changed');
          } catch { throw new ReportRecoveryError('could not confirm PR revisions before publication'); }
          outboxEntry = prepared;
          writeReportOutbox(outboxEntry);
          await publishVerifiedDraft({
          owner,
          beforeFirstReply: () => {
            outboxEntry = { ...outboxEntry!, publicationIntent: 'attempted' };
            writeReportOutbox(outboxEntry);
          },
          repo,
          prNumber,
          headSha: headSha as string,
          prAuthor,
          state,
          draft,
          postInlineReview,
          postReviewCommentReply,
          });
          const published: ReportOutboxEntry = { ...outboxEntry, status: 'published' };
          writeReportOutbox(published);
          outboxEntry = published;
        },
      });
      const elapsed = Date.now() - startTime;
      logger.info(
        `[review-executor] Verification gate passed in ${elapsed}ms ` +
        `(${verifiedDraft.comments.length} inline comment(s), ${verifiedDraft.replies.length} reply/replies)`,
      );

      try {
        if (outboxEntry) {
          if (!preflightHtml) throw new Error('preflight report missing');
          storeOutboxReport(outboxEntry, preflightHtml);
          localReportStatus = 'generated';
        }
      } catch {
        logger.warn(`[review-executor] Local HTML report unavailable for ${owner}/${repo}#${prNumber}; retaining outbox`);
      }
    } catch (err) {
      subagentError = outboxEntry && (outboxEntry as ReportOutboxEntry).status === 'prepared'
        ? publicationFailure(outboxEntry as ReportOutboxEntry, state, err)
        : err instanceof Error ? err : new Error(String(err));
      logger.error(`[review-executor] Review draft/verification failed: ${subagentError.message}`);
      subagentFailed = true;
    } finally {
      if (clonePath) {
        if (cachedWorkspace && repositoryCache) {
          await repositoryCache.cleanupPRWorkspace(clonePath);
        } else {
          await cleanupClone(clonePath);
        }
        logger.info(`[review-executor] Clone cleaned up: ${clonePath}`);
      }
    }

    // ── 4b. Verify the code-side publisher actually landed the review ─────────
    // A successful draft/verification gate does not guarantee GitHub accepted
    // the final API write (for example, an inline line can become invalid).
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
    // A provider capacity error has already exhausted its stage-local backoff.
    // Preserve its type so the polling wrapper releases the review lock without
    // consuming the semantic retry budget or emitting a generic failure alert.
    if (subagentError instanceof ModelCapacityError || subagentError instanceof ReportPublicationAmbiguousError || subagentError instanceof ReportRecoveryError) {
      throw subagentError;
    }

    if (subagentFailed || reviewMissing) {
      const reason = subagentFailed
        ? `${config.reviewAgent} 서브에이전트 실행 실패`
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

    // ── 6. Record the human-decision handoff + update state ──────────────────
    if (!verifiedDraft) {
      throw new Error('Verified review draft is missing after a successful verification gate');
    }
    const verdict: ReviewVerdict = getReviewVerdict(verifiedDraft);
    const prStatus: PRStatus = verdict;

    try {
      state.markPRReviewed(owner, repo, prNumber, prStatus, headSha);
      if (localReportStatus === 'generated' && outboxEntry) deleteReportOutbox(outboxEntry);
      logger.info(`[review-executor] State updated: ${owner}/${repo}#${prNumber} → ${verdict}`);
    } catch (err) {
      logger.warn(`[review-executor] Failed to update state: ${(err as Error).message}`);
    }

    // ── 7. Notify Discord — completion ───────────────────────────────────────
    const severitySummary = getReviewSeveritySummary(verifiedDraft);
    const issueList = severitySummary === '✅ **이슈 없음**' ? [] : [severitySummary];

    try {
      const { sendReviewCompletedNotification } = require('../discord-notifier');
      await sendReviewCompletedNotification({
        owner, repo, prNumber, prTitle, prAuthor, prHeadBranch, prBaseBranch,
        issuesFound: issueList,
        localReportStatus,
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

function executeReview(
  owner: string,
  repo: string,
  prNumber: number,
  stateOverride?: ReviewedPRsState,
  recoveryHeadSha?: string,
): Promise<ReviewResult> {
  const task = reviewShutdown.run(() => executeReviewInternal(owner, repo, prNumber, stateOverride, recoveryHeadSha));
  if (task) return task;

  logger.info(`[review-executor] Draining; refused new review: ${owner}/${repo}#${prNumber}`);
  return Promise.resolve({ success: true, verdict: 'already_reviewed', commentPosted: false });
}

function beginReviewDrain(): void {
  reviewShutdown.beginDrain();
  logger.info(`[review-executor] Draining ${reviewShutdown.activeCount} active review(s)`);
}

function isReviewDraining(): boolean {
  return reviewShutdown.isDraining;
}

function waitForReviewDrain(timeoutMs: number): Promise<GracefulShutdownResult> {
  return reviewShutdown.waitForIdle(timeoutMs);
}

export { beginReviewDrain, executeReview, isReviewDraining, waitForReviewDrain };
