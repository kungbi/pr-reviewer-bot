/**
 * polling-reviewer.js
 *
 * PR 리뷰 실행 래퍼 — 실패 시 재시도 로직 포함.
 * - 최대 3회 재시도 (MAX_RETRIES)
 * - 재시도 카운트는 state 파일에 영구 저장
 * - 3회 실패 후 해당 PR은 skipped 처리
 * - 모든 실패에 타임스탬프 포함 로그 기록
 */

const path = require('path');
const ReviewedPRsState = require('./state-manager');
const logger = require('./logger');

const MAX_RETRIES = ReviewedPRsState.MAX_RETRIES; // 3

const STATE_FILE = path.join(__dirname, '../state/reviewed-prs.json');

/**
 * 상태 파일 로드 헬퍼 (singleton per run)
 */
function loadState() {
  const state = new ReviewedPRsState(STATE_FILE);
  state.load();
  return state;
}

/**
 * PR 리뷰를 안전하게 실행하는 래퍼.
 * 실패 시 재시도 카운트 증가, 3회 초과 시 skip 처리.
 *
 * @param {object} prInfo - { owner, repo, prNumber, title }
 * @param {Function} reviewFn - async 리뷰 실행 함수 (prInfo) => result
 * @returns {Promise<{ success: boolean, skipped: boolean, retryCount: number, result?: any, error?: string }>}
 */
async function executeReviewWithRetry(prInfo, reviewFn) {
  const { owner, repo, prNumber, title } = prInfo;
  const prLabel = `${owner}/${repo}#${prNumber}`;

  const state = loadState();

  // 이미 완전히 skip 된 PR인지 확인
  if (state.isPRSkipped(owner, repo, prNumber)) {
    logger.warn(`[PollingReviewer] PR ${prLabel} is permanently skipped after ${MAX_RETRIES} failures — skipping`);
    return { success: false, skipped: true, retryCount: MAX_RETRIES };
  }

  const currentRetries = state.getPRRetryCount(owner, repo, prNumber);
  logger.info(`[PollingReviewer] Starting review for PR ${prLabel} "${title}" (attempt ${currentRetries + 1}/${MAX_RETRIES})`);

  try {
    const result = await reviewFn(prInfo);

    // 성공 시 retry 카운트 초기화
    state.clearPRRetries(owner, repo, prNumber);
    logger.info(`[PollingReviewer] Review succeeded for PR ${prLabel}`);
    return { success: true, skipped: false, retryCount: currentRetries, result };

  } catch (err) {
    const errMsg = err?.message || String(err);
    const timestamp = new Date().toISOString();

    logger.error(`[PollingReviewer] [${timestamp}] Review FAILED for PR ${prLabel} (attempt ${currentRetries + 1}) — ${errMsg}`);

    // 실패 기록 및 카운트 증가
    const newCount = state.markPRRetryFailure(owner, repo, prNumber, errMsg);

    if (newCount >= MAX_RETRIES) {
      logger.error(
        `[PollingReviewer] [${timestamp}] PR ${prLabel} has failed ${newCount}/${MAX_RETRIES} times — permanently skipping`
      );
      return { success: false, skipped: true, retryCount: newCount, error: errMsg };
    }

    logger.warn(
      `[PollingReviewer] PR ${prLabel} marked for retry (${newCount}/${MAX_RETRIES} failures so far)`
    );
    return { success: false, skipped: false, retryCount: newCount, error: errMsg };
  }
}

/**
 * PR 목록을 순회하면서 미리뷰 PR 처리.
 * - 이미 reviewed된 PR은 건너뜀
 * - 실패한 PR은 재시도 로직을 통해 처리
 *
 * @param {Array<{owner, repo, prNumber, title}>} prs
 * @param {Function} reviewFn - async (prInfo) => result
 */
async function processPRList(prs, reviewFn) {
  const state = loadState();
  const results = [];

  for (const prInfo of prs) {
    const { owner, repo, prNumber } = prInfo;
    const prLabel = `${owner}/${repo}#${prNumber}`;

    // 이미 성공적으로 리뷰 완료된 PR은 건너뜀
    if (state.isPRReviewed(owner, repo, prNumber)) {
      logger.debug(`[PollingReviewer] Skipping already reviewed PR ${prLabel}`);
      results.push({ prLabel, skipped: true, reason: 'already_reviewed' });
      continue;
    }

    const outcome = await executeReviewWithRetry(prInfo, reviewFn);
    results.push({ prLabel, ...outcome });

    // 성공 시 state에 reviewed 표시
    if (outcome.success) {
      state.markPRReviewed(owner, repo, prNumber, 'reviewed');
    }
  }

  return results;
}

module.exports = {
  executeReviewWithRetry,
  processPRList,
  MAX_RETRIES,
};
