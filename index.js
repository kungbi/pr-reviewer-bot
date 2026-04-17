'use strict';

/**
 * index.js — Polling-only entry point
 *
 * No webhook server. Uses gh pr list --assignee @me every 5 minutes.
 * State is tracked in state/reviewed-prs.json via ReviewedPRsState.
 */

require('dotenv').config({ path: '/home/node/.openclaw/workspace/kungbi-pr-reviewer-bot/.env' });

const logger = require('./src/utils/logger');
const { startPolling } = require('./src/polling/poller');

const POLL_INTERVAL_MINUTES = parseInt(process.env.POLL_INTERVAL_MINUTES || '5', 10);

logger.info('=== KungbiSpiders PR Reviewer Bot (polling mode) ===');
logger.info(`Poll interval: every ${POLL_INTERVAL_MINUTES} minute(s)`);

// Start polling — runs once immediately, then on cron schedule
startPolling(POLL_INTERVAL_MINUTES);

// Graceful shutdown
function shutdown(signal) {
  logger.info(`Received ${signal}. Shutting down.`);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
