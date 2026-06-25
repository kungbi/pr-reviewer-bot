import fs from 'fs';
import path from 'path';
import logger from './logger';
import { PRStatus, PRStateEntry, StateFile } from '../types';

const MAX_RETRIES = 3;
// Resolved from this module's location (dist/src/utils → project root), not
// process.cwd(), so the path is stable regardless of where the bot is launched.
export const STATE_FILE = path.join(__dirname, '../../../state/reviewed-prs.json');

// A 'reviewing' lock older than this is treated as stale — the bot likely
// crashed mid-review, so the PR should be re-picked instead of stuck forever.
const REVIEW_TIMEOUT_MIN = Number.parseInt(process.env.REVIEW_TIMEOUT_MIN ?? '20', 10);
const REVIEW_TIMEOUT_MS = (Number.isFinite(REVIEW_TIMEOUT_MIN) ? REVIEW_TIMEOUT_MIN : 20) * 60 * 1000;
const STALE_REVIEWING_MS = REVIEW_TIMEOUT_MS + 5 * 60 * 1000;

class ReviewedPRsState {
  stateFilePath: string;
  data: StateFile;

  constructor(stateFilePath = 'reviewed-prs.json') {
    this.stateFilePath = stateFilePath;
    this.data = {
      reviewedPRs: {},
      repliedComments: {}
    };
  }

  load(): void {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const content = fs.readFileSync(this.stateFilePath, 'utf8');
        const parsed = JSON.parse(content) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
            'reviewedPRs' in parsed) {
          // Correct format — use as-is
          this.data = parsed as StateFile;
        } else if (Array.isArray(parsed)) {
          // Legacy flat-array format — migrate to object format, preserving keys
          logger.warn('[StateManager] Migrating legacy flat-array state to object format');
          const reviewedPRs: Record<string, PRStateEntry> = {};
          for (const key of parsed as string[]) {
            const m = key.match(/^([^/]+)\/([^#]+)#(\d+)$/);
            if (m) {
              reviewedPRs[key] = { owner: m[1], repo: m[2], prNumber: parseInt(m[3]), status: 'reviewed', reviewedAt: new Date().toISOString() };
            }
          }
          this.data = { reviewedPRs, repliedComments: {} };
          this.save();
        } else {
          logger.warn('[StateManager] State file has unexpected format, resetting to defaults');
          this.data = { reviewedPRs: {}, repliedComments: {} };
        }
      }
    } catch (error) {
      logger.error(`[StateManager] Failed to load state: ${(error as Error).message}`);
      this.data = { reviewedPRs: {}, repliedComments: {} };
    }
  }

  save(): void {
    const tempFilePath = `${this.stateFilePath}.tmp`;
    try {
      fs.writeFileSync(tempFilePath, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tempFilePath, this.stateFilePath);
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
    return pr.status === 'reviewed' || pr.status === 'completed' || pr.status === 'skipped';
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
  markPRReviewing(owner: string, repo: string, prNumber: number): void {
    const key = this._getPRKey(owner, repo, prNumber);
    this.data.reviewedPRs[key] = {
      owner,
      repo,
      prNumber,
      status: 'reviewing',
      reviewingAt: new Date().toISOString(),
    };
    this.save();
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
    const monitorable: PRStatus[] = ['reviewed', 'completed', 'blocked', 'needs_work', 'approved'];
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

  /**
   * Get retry count for a PR (0 if not yet retried)
   */
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
    const terminal: PRStatus[] = ['reviewed', 'completed', 'skipped', 'approved', 'needs_work', 'blocked', 'error'];
    const now = Date.now();
    let removed = 0;
    for (const key of Object.keys(this.data.reviewedPRs)) {
      const pr = this.data.reviewedPRs[key];
      if (!terminal.includes(pr.status)) continue;
      const ts = pr.reviewedAt ? new Date(pr.reviewedAt).getTime() : NaN;
      if (isNaN(ts) || now - ts > maxAgeMs) {
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
    sharedInstance = new ReviewedPRsState(STATE_FILE);
    sharedInstance.load();
  }
  return sharedInstance;
}

export default ReviewedPRsState;
export { MAX_RETRIES };
