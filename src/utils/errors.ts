import logger from './logger';

export class GitHubAPIError extends Error {
  statusCode: number;
  headers: Record<string, string>;

  constructor(message: string, statusCode: number, headers: Record<string, string>) {
    super(message);
    this.name = 'GitHubAPIError';
    this.statusCode = statusCode;
    this.headers = headers;
  }
}

export class WebhookError extends Error {
  deliveryId: string;

  constructor(message: string, deliveryId: string) {
    super(message);
    this.name = 'WebhookError';
    this.deliveryId = deliveryId;
  }
}

export class RateLimitError extends Error {
  resetAt: number;

  constructor(message: string, resetAt: number) {
    super(message);
    this.name = 'RateLimitError';
    this.resetAt = resetAt;
  }
}

export function isRateLimited(headers: Record<string, string>): boolean {
  const remaining = parseInt(headers['x-ratelimit-remaining'] || '9999', 10);
  return remaining < 10;
}

export function getRateLimitReset(headers: Record<string, string>): number {
  return parseInt(headers['x-ratelimit-reset'] || '0', 10);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a retrying version of an async function.
 */
export function createRetryFunction<T>(
  func: (...args: unknown[]) => Promise<T>,
  maxRetries = 3,
  delayMs = 1000
): (...args: unknown[]) => Promise<T> {
  return async function (...args: unknown[]): Promise<T> {
    let lastError: Error = new Error('No attempts made');

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await func(...args);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (err instanceof RateLimitError) {
          const resetIn = err.resetAt ? Math.max((err.resetAt * 1000) - Date.now(), delayMs) : delayMs * 2;
          logger.warn(`Rate limited. Waiting ${Math.round(resetIn)}ms before retry ${attempt}/${maxRetries}`);
          await sleep(resetIn);
          continue;
        }

        if (attempt < maxRetries) {
          const backoff = delayMs * Math.pow(2, attempt - 1);
          logger.warn(`Attempt ${attempt}/${maxRetries} failed: ${lastError.message}. Retrying in ${backoff}ms...`);
          await sleep(backoff);
        }
      }
    }

    logger.error(`All ${maxRetries} attempts failed for ${func.name || 'anonymous'}: ${lastError.message}`);
    throw lastError;
  };
}
