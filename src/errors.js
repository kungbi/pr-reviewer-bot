const logger = require('./logger');

class GitHubAPIError extends Error {
  constructor(message, statusCode, headers) {
    super(message);
    this.name = 'GitHubAPIError';
    this.statusCode = statusCode;
    this.headers = headers;
  }
}

class WebhookError extends Error {
  constructor(message, deliveryId) {
    super(message);
    this.name = 'WebhookError';
    this.deliveryId = deliveryId;
  }
}

class RateLimitError extends Error {
  constructor(message, resetAt) {
    super(message);
    this.name = 'RateLimitError';
    this.resetAt = resetAt;
  }
}

function isRateLimited(headers) {
  const remaining = parseInt(headers['x-ratelimit-remaining'] || '9999', 10);
  return remaining < 10;
}

function getRateLimitReset(headers) {
  return parseInt(headers['x-ratelimit-reset'] || '0', 10);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a retrying version of an async function.
 * @param {Function} func - async function to retry
 * @param {number} maxRetries - max retry attempts (default 3)
 * @param {number} delayMs - base delay between retries in ms (default 1000)
 * @returns {Function} wrapped function with retry logic
 */
function createRetryFunction(func, maxRetries = 3, delayMs = 1000) {
  return async function (...args) {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await func(...args);
      } catch (err) {
        lastError = err;

        if (err instanceof RateLimitError) {
          const resetIn = err.resetAt ? Math.max((err.resetAt * 1000) - Date.now(), delayMs) : delayMs * 2;
          logger.warn(`Rate limited. Waiting ${Math.round(resetIn)}ms before retry ${attempt}/${maxRetries}`);
          await sleep(resetIn);
          continue;
        }

        if (attempt < maxRetries) {
          const backoff = delayMs * Math.pow(2, attempt - 1);
          logger.warn(`Attempt ${attempt}/${maxRetries} failed: ${err.message}. Retrying in ${backoff}ms...`);
          await sleep(backoff);
        }
      }
    }

    logger.error(`All ${maxRetries} attempts failed for ${func.name || 'anonymous'}: ${lastError.message}`);
    throw lastError;
  };
}

module.exports = {
  GitHubAPIError,
  WebhookError,
  RateLimitError,
  isRateLimited,
  getRateLimitReset,
  createRetryFunction,
};
