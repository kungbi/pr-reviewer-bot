import 'dotenv/config';
import logger from './utils/logger';
import config from './utils/config';
import { startPolling } from './poller';
import { startDiscordBot } from './discord-bot';

logger.info(`=== ${config.botName} PR Reviewer Bot (polling mode) ===`);
logger.info(`Poll interval: every ${config.pollIntervalMin} minute(s)`);

startPolling(config.pollIntervalMin);
startDiscordBot();

function shutdown(signal: string): void {
  logger.info(`Received ${signal}. Shutting down.`);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
