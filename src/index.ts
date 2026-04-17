
import logger from './utils/logger';
import { startPolling, loadEnv } from './polling/poller';

loadEnv();

const POLL_INTERVAL_MINUTES = parseInt(process.env.POLL_INTERVAL_MINUTES || '5', 10);

logger.info('=== KungbiSpiders PR Reviewer Bot (polling mode) ===');
logger.info(`Poll interval: every ${POLL_INTERVAL_MINUTES} minute(s)`);

startPolling(POLL_INTERVAL_MINUTES);

function shutdown(signal: string): void {
  logger.info(`Received ${signal}. Shutting down.`);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
