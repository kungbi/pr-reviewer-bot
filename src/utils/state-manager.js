const fs = require('fs');
const path = require('path');

const MAX_RETRIES = 3;

class ReviewedPRsState {
  constructor(stateFilePath = 'reviewed-prs.json') {
    this.stateFilePath = stateFilePath;
    this.data = {
      reviewedPRs: {},
      repliedComments: {}
    };
  }

  load() {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const content = fs.readFileSync(this.stateFilePath, 'utf8');
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
            'reviewedPRs' in parsed) {
          // Correct format — use as-is
          this.data = parsed;
        } else if (Array.isArray(parsed)) {
          // Legacy flat-array format — migrate to object format, preserving keys
          console.warn('[StateManager] Migrating legacy flat-array state to object format');
          const reviewedPRs = {};
          for (const key of parsed) {
            const m = key.match(/^([^/]+)\/([^#]+)#(\d+)$/);
            if (m) {
              reviewedPRs[key] = { owner: m[1], repo: m[2], prNumber: parseInt(m[3]), status: 'reviewed', reviewedAt: new Date().toISOString() };
            }
          }
          this.data = { reviewedPRs, repliedComments: {} };
          this.save();
        } else {
          console.warn('[StateManager] State file has unexpected format, resetting to defaults');
          this.data = { reviewedPRs: {}, repliedComments: {} };
        }
      }
    } catch (error) {
      console.error(`[StateManager] Failed to load state: ${error.message}`);
      this.data = { reviewedPRs: {}, repliedComments: {} };
    }
  }

  save() {
    const tempFilePath = `${this.stateFilePath}.tmp`;
    try {
      fs.writeFileSync(tempFilePath, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tempFilePath, this.stateFilePath);
    } catch (error) {
      console.error(`[StateManager] Failed to save state: ${error.message}`);
      throw error;
    }
  }

  _getPRKey(owner, repo, prNumber) {
    return `${owner}/${repo}#${prNumber}`;
  }

  isPRReviewed(owner, repo, prNumber, headSha = null) {
    const key = this._getPRKey(owner, repo, prNumber);
    if (!this.data.reviewedPRs.hasOwnProperty(key)) return false;
    // If headSha provided, only consider reviewed if the SHA matches
    if (headSha) {
      return this.data.reviewedPRs[key].headSha === headSha;
    }
    return true;
  }

  markPRReviewed(owner, repo, prNumber, status = 'reviewed', headSha = null) {
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

  isCommentReplied(commentId) {
    return this.data.repliedComments.hasOwnProperty(commentId);
  }

  markCommentReplied(commentId) {
    this.data.repliedComments[commentId] = {
      commentedAt: new Date().toISOString()
    };
    this.save();
  }

  getPendingReplies() {
    const pending = [];
    for (const key of Object.keys(this.data.reviewedPRs)) {
      const pr = this.data.reviewedPRs[key];
      if (pr.status === 'needs_reply' || pr.status === 'pending_review') {
        pending.push(pr);
      }
    }
    return pending;
  }

  /**
   * Get retry count for a PR (0 if not yet retried)
   */
  getPRRetryCount(owner, repo, prNumber) {
    const key = this._getPRKey(owner, repo, prNumber);
    const pr = this.data.reviewedPRs[key];
    return pr ? (pr.retryCount || 0) : 0;
  }

  /**
   * Mark PR as failed and increment retry count.
   * Returns new retry count.
   */
  markPRRetryFailure(owner, repo, prNumber, errorMessage) {
    const key = this._getPRKey(owner, repo, prNumber);
    const existing = this.data.reviewedPRs[key] || {
      owner, repo, prNumber, status: 'pending_retry', retryCount: 0, failures: []
    };

    const newCount = (existing.retryCount || 0) + 1;
    const updatedEntry = {
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
  isPRSkipped(owner, repo, prNumber) {
    const key = this._getPRKey(owner, repo, prNumber);
    const pr = this.data.reviewedPRs[key];
    return pr && pr.status === 'skipped';
  }

  /**
   * Check if PR is pending retry (previously failed but retries remain)
   */
  isPRPendingRetry(owner, repo, prNumber) {
    const key = this._getPRKey(owner, repo, prNumber);
    const pr = this.data.reviewedPRs[key];
    return pr && pr.status === 'pending_retry';
  }

  /**
   * Reset retry state for a PR (on success)
   */
  clearPRRetries(owner, repo, prNumber) {
    const key = this._getPRKey(owner, repo, prNumber);
    if (this.data.reviewedPRs[key]) {
      delete this.data.reviewedPRs[key].retryCount;
      delete this.data.reviewedPRs[key].failures;
      delete this.data.reviewedPRs[key].lastFailedAt;
      this.data.reviewedPRs[key].status = 'reviewed';
      this.save();
    }
  }
}

const MAX_RETRIES_EXPORT = MAX_RETRIES;

module.exports = ReviewedPRsState;
module.exports.MAX_RETRIES = MAX_RETRIES;
