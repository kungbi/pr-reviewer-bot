import fs from 'fs';
import path from 'path';
import logger from './logger';
import { runtimeStatePath } from './runtime-paths';
import {
  NewReviewPublication,
  PRStatus,
  PRStateEntry,
  ReviewPublication,
  ReviewReplyDelivery,
  ReviewThreadClosure,
  ReviewThreadResolution,
  StateFile,
} from '../types';

const MAX_RETRIES = 3;
export const STATE_FILE = runtimeStatePath('reviewed-prs.json');

// A 'reviewing' lock older than this is treated as stale — the bot likely
// crashed mid-review, so the PR should be re-picked instead of stuck forever.
const REVIEW_TIMEOUT_MIN = Number.parseInt(process.env.REVIEW_TIMEOUT_MIN ?? '20', 10);
const REVIEW_TIMEOUT_MS = (Number.isFinite(REVIEW_TIMEOUT_MIN) ? REVIEW_TIMEOUT_MIN : 20) * 60 * 1000;
const STALE_REVIEWING_MS = REVIEW_TIMEOUT_MS + 5 * 60 * 1000;

class ReviewedPRsState {
  stateFilePath: string;
  data: StateFile;
  private reviewPublicationLockHeld = false;

  constructor(stateFilePath = runtimeStatePath('reviewed-prs.json')) {
    this.stateFilePath = stateFilePath;
    this.data = {
      reviewedPRs: {},
      repliedComments: {}
    };
  }

  private parseStateData(parsed: unknown): { data: StateFile; migrated: boolean } {
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
        'reviewedPRs' in parsed) {
      const candidate = parsed as Partial<StateFile>;
      if (!candidate.reviewedPRs || typeof candidate.reviewedPRs !== 'object' ||
          Array.isArray(candidate.reviewedPRs)) {
        throw new Error('State file has unexpected format: reviewedPRs must be an object');
      }
      if (candidate.repliedComments !== undefined &&
          (!candidate.repliedComments || typeof candidate.repliedComments !== 'object' || Array.isArray(candidate.repliedComments))) {
        throw new Error('State file has unexpected format: repliedComments must be an object');
      }
      if (candidate.reviewPublications !== undefined &&
          (!candidate.reviewPublications || typeof candidate.reviewPublications !== 'object' || Array.isArray(candidate.reviewPublications))) {
        throw new Error('State file has unexpected format: reviewPublications must be an object');
      }
      if (candidate.reviewRetryBudgets !== undefined) {
        const budgets = candidate.reviewRetryBudgets;
        if (!budgets || typeof budgets !== 'object' || Array.isArray(budgets)
          || Object.values(budgets).some(b => !b || !Number.isSafeInteger(b.retryCount) || b.retryCount < 0
            || typeof b.blocked !== 'boolean'
            || (b.failureNotification !== undefined && !['attempted', 'completed', 'delivery_unknown', 'suppressed_legacy'].includes(b.failureNotification)))) {
          throw new Error('Invalid durable review retry budgets');
        }
      }
      return {
        data: {
          ...candidate,
          reviewedPRs: candidate.reviewedPRs,
          repliedComments: candidate.repliedComments ?? {},
        } as StateFile,
        migrated: false,
      };
    }

    if (Array.isArray(parsed)) {
      const reviewedPRs: Record<string, PRStateEntry> = {};
      for (const key of parsed as unknown[]) {
        if (typeof key !== 'string') continue;
        const match = key.match(/^([^/]+)\/([^#]+)#(\d+)$/);
        if (match) {
          reviewedPRs[key] = {
            owner: match[1],
            repo: match[2],
            prNumber: parseInt(match[3]),
            status: 'reviewed',
            reviewedAt: new Date().toISOString(),
          };
        }
      }
      return { data: { reviewedPRs, repliedComments: {} }, migrated: true };
    }

    throw new Error('State file has unexpected format');
  }

  private loadReviewPublicationStateStrict(): void {
    if (!fs.existsSync(this.stateFilePath)) {
      throw new Error(`Durable state file is missing: ${this.stateFilePath}`);
    }
    const parsed = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf8')) as unknown;
    this.data = this.parseStateData(parsed).data;
  }

  private withReviewPublicationLock(operation: () => boolean, refreshBeforeOperation = true): boolean {
    const lockFilePath = `${this.stateFilePath}.review-publication.lock`;
    const stateDir = path.resolve(path.dirname(this.stateFilePath));
    fs.mkdirSync(stateDir, { recursive: true });
    // Persist the directory chain too, including after a previous mkdir/sync
    // failed: an existing directory is not proof its parent entry is durable.
    for (let child = stateDir; path.dirname(child) !== child; child = path.dirname(child)) {
      const parentFd = fs.openSync(path.dirname(child), 'r');
      try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
    }
    let lockFd: number;
    try {
      lockFd = fs.openSync(lockFilePath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        logger.warn(`[StateManager] State file is locked: ${lockFilePath}`);
        return false;
      }
      throw error;
    }

    this.reviewPublicationLockHeld = true;
    try {
      if (refreshBeforeOperation) {
        // Another process or state instance may have written since this instance
        // loaded. Refresh under the exclusive lock before every transition.
        this.loadReviewPublicationStateStrict();
      }
      return operation();
    } finally {
      this.reviewPublicationLockHeld = false;
      fs.closeSync(lockFd);
      try {
        fs.unlinkSync(lockFilePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  load(): void {
    try {
      const loaded = this.withReviewPublicationLock(() => {
        let content: string;
        try {
          content = fs.readFileSync(this.stateFilePath, 'utf8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          const outbox = path.join(path.dirname(this.stateFilePath), 'review-report-outbox');
          if (path.resolve(this.stateFilePath) === runtimeStatePath('reviewed-prs.json')
              && fs.existsSync(outbox) && fs.readdirSync(outbox).length > 0) {
            throw new Error(`Durable state file is missing alongside an existing report outbox: ${this.stateFilePath}`);
          }
          // Only explicit startup load may initialize a first-run store, under
          // the same exclusive lock and durable write protocol as publication.
          this.data = { reviewedPRs: {}, repliedComments: {} };
          this.writeStateFile();
          return true;
        }
        const loaded = this.parseStateData(JSON.parse(content) as unknown);
        this.data = loaded.data;
        const previousBudgets = JSON.stringify(this.data.reviewRetryBudgets);
        for (const pr of Object.values(this.data.reviewedPRs)) {
          this.importLegacyRetryBudget(pr.owner, pr.repo, pr.prNumber);
        }
        if (previousBudgets !== JSON.stringify(this.data.reviewRetryBudgets)) this.save();
        if (loaded.migrated) {
          logger.warn('[StateManager] Migrating legacy flat-array state to object format');
          this.save();
        }
        return true;
      }, false);
      if (!loaded) throw new Error(`Could not acquire state lock for ${this.stateFilePath}`);
    } catch (error) {
      logger.error(`[StateManager] Failed to load state: ${(error as Error).message}`);
      throw error;
    }
  }

  private readPersistedReviewPublications(): Record<string, ReviewPublication> {
    if (!fs.existsSync(this.stateFilePath)) {
      throw new Error(`Durable state file is missing: ${this.stateFilePath}`);
    }
    const parsed = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf8')) as unknown;
    return this.parseStateData(parsed).data.reviewPublications ?? {};
  }

  private writeStateFile(): void {
    const tempFilePath = `${this.stateFilePath}.tmp`;
    const fd = fs.openSync(tempFilePath, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(this.data, null, 2), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempFilePath, this.stateFilePath);
    const dirFd = fs.openSync(path.dirname(this.stateFilePath), 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  }

  save(): void {
    try {
      if (this.reviewPublicationLockHeld) {
        this.writeStateFile();
        return;
      }

      const pendingData = this.data;
      const saved = this.withReviewPublicationLock(() => {
        const persistedData = fs.existsSync(this.stateFilePath)
          ? this.parseStateData(JSON.parse(fs.readFileSync(this.stateFilePath, 'utf8'))).data : undefined;
        const budgets = { ...(pendingData.reviewRetryBudgets ?? {}) };
        for (const [key, durable] of Object.entries(persistedData?.reviewRetryBudgets ?? {})) {
          const pending = budgets[key];
          budgets[key] = {
            retryCount: Math.max(durable.retryCount, pending?.retryCount ?? 0),
            blocked: durable.blocked || !!pending?.blocked,
            failureNotification: durable.failureNotification ?? pending?.failureNotification,
          };
        }
        // Generic PR/reply state may be stale in another process. Never let it
        // delete or downgrade a durable review-publication tombstone already on disk.
        const persistedPublications = fs.existsSync(this.stateFilePath)
          ? this.readPersistedReviewPublications()
          : {};
        this.data = {
          ...pendingData,
          reviewRetryBudgets: budgets,
          reviewPublications: {
            ...(pendingData.reviewPublications ?? {}),
            ...persistedPublications,
          },
        };
        this.writeStateFile();
        return true;
      }, false);
      if (!saved) {
        throw new Error(`Could not acquire state lock for ${this.stateFilePath}`);
      }
    } catch (error) {
      logger.error(`[StateManager] Failed to save state: ${(error as Error).message}`);
      throw error;
    }
  }

  _getPRKey(owner: string, repo: string, prNumber: number): string {
    return `${owner}/${repo}#${prNumber}`;
  }

  isPRReviewed(owner: string, repo: string, prNumber: number, headSha: string | null = null): boolean {
    const key = this._getPRKey(owner, repo, prNumber);
    if (!Object.prototype.hasOwnProperty.call(this.data.reviewedPRs, key)) return false;
    // If headSha provided, only consider reviewed if the SHA matches
    if (headSha) {
      return this.data.reviewedPRs[key].headSha === headSha;
    }
    return true;
  }

  /**
   * Returns the HEAD SHA recorded at the last review, or null if none.
   * Used to compute the new-commits delta on a re-review.
   */
  getReviewedHeadSha(owner: string, repo: string, prNumber: number): string | null {
    const key = this._getPRKey(owner, repo, prNumber);
    return this.data.reviewedPRs[key]?.headSha ?? null;
  }

  /**
   * Returns true only if the PR is successfully completed or permanently skipped.
   * Does NOT return true for 'reviewing' or 'pending_retry'.
   */
  isPRCompleted(owner: string, repo: string, prNumber: number): boolean {
    const key = this._getPRKey(owner, repo, prNumber);
    const pr = this.data.reviewedPRs[key];
    if (!pr) return false;
    return pr.status === 'reviewed'
      || pr.status === 'completed'
      || pr.status === 'skipped'
      || pr.status === 'awaiting_human_review';
  }

  /**
   * Returns true if the PR is currently being reviewed (in-progress lock).
   *
   * A 'reviewing' entry whose `reviewingAt` is older than STALE_REVIEWING_MS
   * (or missing/invalid) is treated as stale: the bot most likely crashed
   * mid-review and never cleared the lock. Returning false there lets the
   * poller re-pick the PR instead of skipping it forever.
   */
  isPRReviewing(owner: string, repo: string, prNumber: number): boolean {
    const key = this._getPRKey(owner, repo, prNumber);
    const pr = this.data.reviewedPRs[key];
    if (!pr || pr.status !== 'reviewing') return false;

    const startedAt = pr.reviewingAt ? new Date(pr.reviewingAt).getTime() : NaN;
    const age = Date.now() - startedAt;
    if (isNaN(age) || age > STALE_REVIEWING_MS) {
      logger.warn(`[StateManager] Stale 'reviewing' lock on ${key} — treating as not in-progress`);
      return false;
    }
    return true;
  }

  /**
   * Mark PR as currently in-progress before starting the review.
   * This prevents duplicate reviews across cron cycles (race condition lock).
   */
  markPRReviewing(owner: string, repo: string, prNumber: number, headSha: string | null = null): void {
    const key = this._getPRKey(owner, repo, prNumber);
    const existing = this.data.reviewedPRs[key];
    // Legacy callers must not erase exhaustion before the retry gate can see it.
    if (existing && (existing.status === 'skipped' || (existing.retryCount ?? 0) >= MAX_RETRIES)) return;
    this.data.reviewedPRs[key] = {
      ...existing,
      owner,
      repo,
      prNumber,
      status: 'reviewing',
      reviewingAt: new Date().toISOString(),
      reviewingHeadSha: headSha,
    };
    this.save();
  }

  releaseReviewingAtRevision(owner: string, repo: string, prNumber: number, headSha: string): boolean {
    return this.withReviewPublicationLock(() => {
      if (!fs.existsSync(this.stateFilePath)) return false;
      this.loadReviewPublicationStateStrict();
      const entry = this.data.reviewedPRs[this._getPRKey(owner, repo, prNumber)];
      if (entry?.status !== 'reviewing' || !entry.reviewingHeadSha
        || entry.reviewingHeadSha.toLowerCase() !== headSha.toLowerCase()) return false;
      entry.status = 'pending_retry';
      delete entry.reviewingAt;
      delete entry.reviewingHeadSha;
      this.save();
      return true;
    }, false);
  }

  markPRReviewed(owner: string, repo: string, prNumber: number, status: PRStatus = 'reviewed', headSha: string | null = null): void {
    const key = this._getPRKey(owner, repo, prNumber);
    this.data.reviewedPRs[key] = {
      owner,
      repo,
      prNumber,
      status,
      headSha,
      reviewedAt: new Date().toISOString()
    };
    this.save();
  }

  isCommentReplied(commentId: string | number): boolean {
    return Object.prototype.hasOwnProperty.call(this.data.repliedComments, commentId);
  }

  markCommentReplied(commentId: string | number): void {
    this.data.repliedComments[String(commentId)] = {
      commentedAt: new Date().toISOString()
    };
    this.save();
  }

  isReviewThreadClosed(threadKey: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.data.closedReviewThreads ?? {}, threadKey);
  }

  markReviewThreadClosed(threadKey: string, resolution: ReviewThreadResolution): void {
    this.data.closedReviewThreads ??= {};
    this.data.closedReviewThreads[threadKey] = {
      closedAt: new Date().toISOString(),
      resolution,
    };
    this.save();
  }

  recordReviewThreadHandoff(threadKey: string, commentId: string | number): boolean {
    if (this.isReviewThreadClosed(threadKey)) return false;
    const now = new Date().toISOString();
    this.data.closedReviewThreads ??= {};
    this.data.closedReviewThreads[threadKey] = {
      closedAt: now,
      resolution: 'human_handoff',
      handledCommentId: String(commentId),
    };
    this.data.repliedComments[String(commentId)] = { commentedAt: now };
    this.save();
    return true;
  }

  reserveReviewThreadReconsideration(
    threadKey: string,
    commentId: string | number,
    triggeringLogin: string,
    pendingReplyBody: string,
    pendingHeadSha: string,
    operationMarker: string,
  ): boolean {
    if (this.isReviewThreadClosed(threadKey)) return false;
    const now = new Date().toISOString();
    this.data.closedReviewThreads ??= {};
    this.data.closedReviewThreads[threadKey] = {
      closedAt: now,
      resolution: 'reconsideration_pending',
      handledCommentId: String(commentId),
      handledCommentLogin: triggeringLogin,
      pendingReplyBody,
      pendingHeadSha,
      operationMarker,
      postAttempted: false,
    };
    this.data.repliedComments[String(commentId)] = { commentedAt: now };
    this.save();
    return true;
  }

  markReviewThreadReconsiderationPostAttempted(threadKey: string): boolean {
    const closure = this.data.closedReviewThreads?.[threadKey];
    if (!closure || closure.resolution !== 'reconsideration_pending' || closure.postAttempted) return false;
    closure.postAttempted = true;
    this.save();
    return true;
  }

  completeReviewThreadReconsideration(threadKey: string): boolean {
    const closure = this.data.closedReviewThreads?.[threadKey];
    if (!closure || !['reconsideration_pending', 'reconsideration_delivery_unknown'].includes(closure.resolution)) return false;
    closure.resolution = 'reconsidered_merge_boundary';
    delete closure.pendingReplyBody;
    delete closure.pendingHeadSha;
    delete closure.operationMarker;
    delete closure.postAttempted;
    this.save();
    return true;
  }

  markReviewThreadReconsiderationDeliveryUnknown(threadKey: string): boolean {
    const closure = this.data.closedReviewThreads?.[threadKey];
    if (!closure || closure.resolution !== 'reconsideration_pending') return false;
    closure.resolution = 'reconsideration_delivery_unknown';
    this.save();
    return true;
  }

  cancelReviewThreadReconsideration(threadKey: string): boolean {
    const closure = this.data.closedReviewThreads?.[threadKey];
    if (!closure || closure.resolution !== 'reconsideration_pending' || closure.postAttempted) return false;
    if (closure.handledCommentId) delete this.data.repliedComments[closure.handledCommentId];
    delete this.data.closedReviewThreads![threadKey];
    this.save();
    return true;
  }

  getReviewThreadClosure(threadKey: string): ReviewThreadClosure | undefined {
    return this.data.closedReviewThreads?.[threadKey];
  }

  reserveReviewReplyDelivery(
    deliveryKey: string,
    humanReplyId: string | number,
    parentCommentId: number,
    pendingReplyBody: string,
    pendingHeadSha: string,
    operationMarker: string,
  ): boolean {
    if (this.isCommentReplied(humanReplyId) || this.data.pendingReviewReplies?.[deliveryKey]) return false;
    this.data.pendingReviewReplies ??= {};
    this.data.pendingReviewReplies[deliveryKey] = {
      createdAt: new Date().toISOString(),
      resolution: 'pending',
      humanReplyId: String(humanReplyId),
      parentCommentId,
      pendingReplyBody,
      pendingHeadSha,
      operationMarker,
      postAttempted: false,
    };
    this.save();
    return true;
  }

  getReviewReplyDelivery(deliveryKey: string): ReviewReplyDelivery | undefined {
    return this.data.pendingReviewReplies?.[deliveryKey];
  }

  markReviewReplyDeliveryPostAttempted(deliveryKey: string): boolean {
    const delivery = this.data.pendingReviewReplies?.[deliveryKey];
    if (!delivery || delivery.resolution !== 'pending' || delivery.postAttempted) return false;
    delivery.postAttempted = true;
    this.save();
    return true;
  }

  markReviewReplyDeliveryUnknown(deliveryKey: string): boolean {
    const delivery = this.data.pendingReviewReplies?.[deliveryKey];
    if (!delivery || delivery.resolution !== 'pending') return false;
    delivery.resolution = 'delivery_unknown';
    this.save();
    return true;
  }

  completeReviewReplyDelivery(deliveryKey: string): boolean {
    const delivery = this.data.pendingReviewReplies?.[deliveryKey];
    if (!delivery) return false;
    this.data.repliedComments[delivery.humanReplyId] = { commentedAt: new Date().toISOString() };
    delete this.data.pendingReviewReplies![deliveryKey];
    this.save();
    return true;
  }

  cancelReviewReplyDelivery(deliveryKey: string): boolean {
    const delivery = this.data.pendingReviewReplies?.[deliveryKey];
    if (!delivery || delivery.resolution !== 'pending' || delivery.postAttempted) return false;
    delete this.data.pendingReviewReplies![deliveryKey];
    this.save();
    return true;
  }

  getReviewPublication(publicationKey: string): ReviewPublication | undefined {
    return this.data.reviewPublications?.[publicationKey];
  }

  getDurableReviewPublication(publicationKey: string): ReviewPublication | undefined {
    let publication: ReviewPublication | undefined;
    if (!this.withReviewPublicationLock(() => {
      publication = this.data.reviewPublications?.[publicationKey];
      return true;
    })) throw new Error('Cannot inspect durable review publication state');
    return publication;
  }

  reserveReviewPublication(publicationKey: string, publication: NewReviewPublication): boolean {
    return this.withReviewPublicationLock(() => {
      if (this.data.reviewPublications?.[publicationKey]) return false;
      this.data.reviewPublications ??= {};
      this.data.reviewPublications[publicationKey] = {
        ...publication,
        createdAt: new Date().toISOString(),
        status: 'pending',
        postAttempted: false,
      };
      this.save();
      return true;
    });
  }

  markReviewPublicationPostAttempted(publicationKey: string): boolean {
    return this.withReviewPublicationLock(() => {
      const publication = this.data.reviewPublications?.[publicationKey];
      if (!publication || publication.status !== 'pending' || publication.postAttempted) return false;
      publication.postAttempted = true;
      this.save();
      return true;
    });
  }

  fallbackReviewPublicationToComment(publicationKey: string): boolean {
    return this.withReviewPublicationLock(() => {
      const publication = this.data.reviewPublications?.[publicationKey];
      if (
        !publication
        || publication.status !== 'pending'
        || publication.postAttempted
        || !publication.pendingEvent
        || publication.pendingEvent === 'COMMENT'
      ) return false;

      publication.pendingEvent = 'COMMENT';
      this.save();
      return true;
    });
  }

  markReviewPublicationDeliveryUnknown(publicationKey: string): boolean {
    return this.withReviewPublicationLock(() => {
      const publication = this.data.reviewPublications?.[publicationKey];
      if (!publication) return false;
      if (publication.status === 'delivery_unknown') return publication.postAttempted;
      if (publication.status !== 'pending' || !publication.postAttempted) return false;

      publication.status = 'delivery_unknown';
      this.save();
      return true;
    });
  }

  completeReviewPublication(publicationKey: string, reviewId?: number): boolean {
    return this.withReviewPublicationLock(() => {
      const publication = this.data.reviewPublications?.[publicationKey];
      if (!publication) return false;
      publication.status = 'completed';
      publication.postAttempted = true;
      publication.completedAt = new Date().toISOString();
      if (reviewId !== undefined) publication.reviewId = reviewId;
      delete publication.pendingBody;
      delete publication.pendingEvent;
      delete publication.pendingComments;
      this.save();
      return true;
    });
  }

  getPendingReplies(): PRStateEntry[] {
    const pending: PRStateEntry[] = [];
    for (const key of Object.keys(this.data.reviewedPRs)) {
      const pr = this.data.reviewedPRs[key];
      if (pr.status === 'needs_reply' || pr.status === 'pending_review') {
        pending.push(pr);
      }
    }
    return pending;
  }

  getPRsForReplyMonitoring(lookbackDays: number | null = null): PRStateEntry[] {
    const monitorable: PRStatus[] = [
      'reviewed', 'completed', 'awaiting_human_review', 'blocked', 'needs_work', 'approved',
    ];
    const minReviewedAtMs = lookbackDays && lookbackDays > 0
      ? Date.now() - lookbackDays * 24 * 60 * 60 * 1000
      : null;

    return Object.values(this.data.reviewedPRs).filter((pr) => {
      if (!monitorable.includes(pr.status)) return false;
      if (minReviewedAtMs === null) return true;
      const reviewedAtMs = pr.reviewedAt ? new Date(pr.reviewedAt).getTime() : NaN;
      return Number.isFinite(reviewedAtMs) && reviewedAtMs >= minReviewedAtMs;
    });
  }

  getReplyMonitorStartedAt(): string {
    if (!this.data.replyMonitorStartedAt) {
      this.data.replyMonitorStartedAt = new Date().toISOString();
      this.save();
      logger.info(`[StateManager] Initialized reply monitor watermark at ${this.data.replyMonitorStartedAt}`);
    }
    return this.data.replyMonitorStartedAt;
  }

  private retryKey(owner: string, repo: string, prNumber: number, headSha: string | null): string {
    return `${this._getPRKey(owner, repo, prNumber)}:${headSha ?? 'unknown'}`;
  }

  private exactRetrySha(value: unknown): string | null {
    return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) ? value : null;
  }

  private importLegacyRetryBudget(owner: string, repo: string, prNumber: number): void {
    const pr = this.data.reviewedPRs[this._getPRKey(owner, repo, prNumber)];
    if (!pr || (!(pr.retryCount ?? 0) && pr.status !== 'skipped')) return;
    // A successful review SHA is not evidence of which revision failed.
    const sha = this.exactRetrySha(pr.retryHeadSha ?? pr.reviewingHeadSha);
    const key = this.retryKey(owner, repo, prNumber, sha);
    this.data.reviewRetryBudgets ??= {};
    const previous = this.data.reviewRetryBudgets[key];
    const count = Math.max(pr.retryCount ?? 0, previous?.retryCount ?? 0);
    const blocked = !!previous?.blocked || pr.status === 'skipped' || count >= MAX_RETRIES;
    this.data.reviewRetryBudgets[key] = {
      retryCount: count, blocked,
      failureNotification: previous?.failureNotification ?? (blocked ? 'suppressed_legacy' : undefined),
    };
  }

  /** Unknown revisions never establish a new retry budget. Call under the state lock. */
  private retryBlocked(owner: string, repo: string, prNumber: number, headSha: string | null): boolean {
    const budgets = this.data.reviewRetryBudgets ?? {};
    const unknown = budgets[this.retryKey(owner, repo, prNumber, null)];
    const current = budgets[this.retryKey(owner, repo, prNumber, headSha)];
    return !this.exactRetrySha(headSha) || !!unknown || !!current?.blocked || (current?.retryCount ?? 0) >= MAX_RETRIES;
  }

  isPRRetryBlocked(owner: string, repo: string, prNumber: number, headSha: string | null): boolean {
    let blocked = true;
    if (!this.withReviewPublicationLock(() => {
      this.importLegacyRetryBudget(owner, repo, prNumber);
      blocked = this.retryBlocked(owner, repo, prNumber, headSha);
      this.save();
      return true;
    })) throw new Error('Cannot inspect durable retry budget');
    return blocked;
  }

  /** Atomically gate every ingress before changing mutable PR status. */
  beginPRRetryAttempt(owner: string, repo: string, prNumber: number, headSha: string | null): boolean {
    return this.withReviewPublicationLock(() => {
      this.importLegacyRetryBudget(owner, repo, prNumber);
      if (this.retryBlocked(owner, repo, prNumber, headSha) || this.isPRReviewing(owner, repo, prNumber)
        || (this.isPRCompleted(owner, repo, prNumber) && this.getReviewedHeadSha(owner, repo, prNumber) === headSha)) {
        this.save();
        return false;
      }
      const key = this._getPRKey(owner, repo, prNumber);
      const existing = this.data.reviewedPRs[key];
      const budgetKey = this.retryKey(owner, repo, prNumber, headSha);
      this.data.reviewRetryBudgets ??= {};
      const budget = this.data.reviewRetryBudgets[budgetKey] ??= { retryCount: 0, blocked: false };
      this.data.reviewedPRs[key] = {
        ...existing, owner, repo, prNumber, status: 'reviewing',
        reviewingAt: new Date().toISOString(), reviewingHeadSha: headSha, retryHeadSha: headSha,
        retryCount: budget.retryCount,
        failures: existing?.retryHeadSha === headSha ? existing.failures : [],
      };
      this.save();
      return true;
    });
  }

  recordPRRevisionFailure(owner: string, repo: string, prNumber: number, headSha: string, errorMessage: string): number {
    let count = MAX_RETRIES;
    if (!this.withReviewPublicationLock(() => {
      const budget = this.data.reviewRetryBudgets?.[this.retryKey(owner, repo, prNumber, headSha)];
      if (!budget) throw new Error('Missing exact revision retry reservation');
      count = budget.retryCount = budget.blocked || budget.retryCount >= MAX_RETRIES
        ? budget.retryCount : budget.retryCount + 1;
      budget.blocked ||= count >= MAX_RETRIES;
      const pr = this.data.reviewedPRs[this._getPRKey(owner, repo, prNumber)];
      if (pr?.retryHeadSha === headSha) {
        pr.retryCount = count;
        pr.status = budget.blocked ? 'skipped' : 'pending_retry';
        pr.lastFailedAt = new Date().toISOString();
        pr.failures = [...(pr.failures ?? []), { timestamp: pr.lastFailedAt, error: errorMessage }];
      }
      this.save();
      return true;
    })) throw new Error('Cannot persist revision failure');
    return count;
  }

  reserveFailureNotification(owner: string, repo: string, prNumber: number, headSha: string): boolean {
    return this.withReviewPublicationLock(() => {
      const budget = this.data.reviewRetryBudgets?.[this.retryKey(owner, repo, prNumber, headSha)];
      if (!budget?.blocked || budget.retryCount !== MAX_RETRIES || budget.failureNotification) return false;
      // Persist POST intent before calling any external writer. Never replay.
      budget.failureNotification = 'attempted';
      this.save();
      return true;
    });
  }

  completePRRetryAttempt(owner: string, repo: string, prNumber: number, headSha: string): void {
    if (!this.withReviewPublicationLock(() => {
      const pr = this.data.reviewedPRs[this._getPRKey(owner, repo, prNumber)];
      const ownsAttempt = pr?.status === 'reviewing' || pr?.status === 'pending_retry'
        ? pr.retryHeadSha === headSha : pr?.headSha === headSha;
      if (pr && ownsAttempt) {
        delete pr.retryCount;
        delete pr.failures;
        delete pr.lastFailedAt;
        delete pr.capacityRetryCount;
        delete pr.lastCapacityAt;
        delete pr.lastCapacityError;
        if (pr.status === 'reviewing') pr.status = 'reviewed';
      }
      // Preserve the executor's COMMENT/report verdict and durable tombstones.
      this.save();
      return true;
    })) throw new Error('Cannot finalize retry attempt');
  }

  finishFailureNotification(owner: string, repo: string, prNumber: number, headSha: string, delivered: boolean): void {
    if (!this.withReviewPublicationLock(() => {
      const budget = this.data.reviewRetryBudgets?.[this.retryKey(owner, repo, prNumber, headSha)];
      if (!budget || budget.failureNotification !== 'attempted') return false;
      budget.failureNotification = delivered ? 'completed' : 'delivery_unknown';
      this.save();
      return true;
    })) throw new Error('Cannot finalize failure notification');
  }

  /** Get retry count for a PR (0 if not yet retried). */
  getPRRetryCount(owner: string, repo: string, prNumber: number): number {
    const key = this._getPRKey(owner, repo, prNumber);
    const pr = this.data.reviewedPRs[key];
    return pr ? (pr.retryCount || 0) : 0;
  }

  /**
   * Mark PR as failed and increment retry count.
   * Returns new retry count.
   */
  markPRRetryFailure(owner: string, repo: string, prNumber: number, errorMessage: string): number {
    const key = this._getPRKey(owner, repo, prNumber);
    const existing: PRStateEntry = this.data.reviewedPRs[key] || {
      owner, repo, prNumber, status: 'pending_retry', retryCount: 0, failures: []
    };

    const newCount = (existing.retryCount || 0) + 1;
    const updatedEntry: PRStateEntry = {
      ...existing,
      owner,
      repo,
      prNumber,
      status: newCount >= MAX_RETRIES ? 'skipped' : 'pending_retry',
      retryCount: newCount,
      failures: [
        ...(existing.failures || []),
        {
          timestamp: new Date().toISOString(),
          error: errorMessage
        }
      ],
      lastFailedAt: new Date().toISOString()
    };

    this.data.reviewedPRs[key] = updatedEntry;
    this.save();
    return newCount;
  }

  /**
   * Release the in-progress lock after a provider capacity failure without
   * consuming the semantic retry budget. The next polling cycle may retry it.
   */
  markPRCapacityRetry(owner: string, repo: string, prNumber: number, errorMessage: string, expectedHeadSha?: string): void {
    if (expectedHeadSha) {
      if (!this.withReviewPublicationLock(() => {
        const current = this.data.reviewedPRs[this._getPRKey(owner, repo, prNumber)];
        if (current?.status === 'reviewing' && current.retryHeadSha === expectedHeadSha) {
          this.markPRCapacityRetry(owner, repo, prNumber, errorMessage);
        }
        return true;
      })) throw new Error('Cannot release exact revision retry lock');
      return;
    }
    const key = this._getPRKey(owner, repo, prNumber);
    const existing: PRStateEntry = this.data.reviewedPRs[key] || {
      owner, repo, prNumber, status: 'pending_retry', retryCount: 0, failures: []
    };
    const now = new Date().toISOString();

    this.data.reviewedPRs[key] = {
      ...existing,
      owner,
      repo,
      prNumber,
      status: 'pending_retry',
      capacityRetryCount: (existing.capacityRetryCount || 0) + 1,
      lastCapacityAt: now,
      lastCapacityError: errorMessage,
      reviewingAt: undefined,
    };
    this.save();
  }

  /**
   * Check if PR is permanently skipped (max retries exceeded)
   */
  isPRSkipped(owner: string, repo: string, prNumber: number): boolean {
    const key = this._getPRKey(owner, repo, prNumber);
    const pr = this.data.reviewedPRs[key];
    return !!(pr && pr.status === 'skipped');
  }

  /**
   * Check if PR is pending retry (previously failed but retries remain)
   */
  isPRPendingRetry(owner: string, repo: string, prNumber: number): boolean {
    const key = this._getPRKey(owner, repo, prNumber);
    const pr = this.data.reviewedPRs[key];
    return !!(pr && pr.status === 'pending_retry');
  }

  /**
   * Reset retry state for a PR (on success)
   */
  clearPRRetries(owner: string, repo: string, prNumber: number): void {
    const key = this._getPRKey(owner, repo, prNumber);
    if (this.data.reviewedPRs[key]) {
      delete this.data.reviewedPRs[key].retryCount;
      delete this.data.reviewedPRs[key].failures;
      delete this.data.reviewedPRs[key].lastFailedAt;
      delete this.data.reviewedPRs[key].capacityRetryCount;
      delete this.data.reviewedPRs[key].lastCapacityAt;
      delete this.data.reviewedPRs[key].lastCapacityError;
      this.data.reviewedPRs[key].status = 'reviewed';
      this.save();
    }
  }

  /**
   * Delete completed (terminal-status) PR entries older than maxAgeMs so the
   * state file does not grow unbounded. In-progress / retry-pending entries
   * are kept regardless of age. Returns the number of entries removed.
   */
  pruneOldEntries(maxAgeMs: number): number {
    const terminal: PRStatus[] = [
      'reviewed', 'completed', 'skipped', 'awaiting_human_review', 'approved', 'needs_work', 'blocked', 'error',
    ];
    const now = Date.now();
    let removed = 0;
    for (const key of Object.keys(this.data.reviewedPRs)) {
      const pr = this.data.reviewedPRs[key];
      if (!terminal.includes(pr.status)) continue;
      // Keep un-migrated legacy exhaustion; deleting it would reopen a failed PR.
      if (pr.status === 'skipped' || (pr.retryCount ?? 0) > 0) continue;
      const ts = pr.reviewedAt ? new Date(pr.reviewedAt).getTime() : NaN;
      if (isNaN(ts) || now - ts > maxAgeMs) {
        // Publication tombstones and ambiguous outbox records are independent safety state.
        // Removing PR metadata must never reopen a terminal thread or allow a duplicate POST.
        delete this.data.reviewedPRs[key];
        removed++;
      }
    }
    if (removed > 0) {
      this.save();
      logger.info(`[StateManager] Pruned ${removed} completed PR entr${removed === 1 ? 'y' : 'ies'} older than ${Math.round(maxAgeMs / 86400000)}d`);
    }
    return removed;
  }
}

let sharedInstance: ReviewedPRsState | null = null;

/**
 * Process-wide shared state instance. All call sites must use this so there
 * is a single in-memory copy — multiple instances each doing a full-file
 * save() would clobber each other's updates (lost-update race).
 */
export function getSharedState(): ReviewedPRsState {
  if (!sharedInstance) {
    const instance = new ReviewedPRsState();
    instance.load();
    sharedInstance = instance;
  }
  return sharedInstance;
}

export default ReviewedPRsState;
export { MAX_RETRIES };
