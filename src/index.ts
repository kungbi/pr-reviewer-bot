import 'dotenv/config';
import logger from './utils/logger';
import config from './utils/config';
import { startPolling } from './poller';
import { startDiscordBot } from './discord-bot';
import { cleanupStaleClones } from './review/repo-cloner';

async function main(): Promise<void> {
  logger.info(`=== ${config.botName} PR Reviewer Bot (polling mode) ===`);
  logger.info(`Poll interval: every ${config.pollIntervalMin} minute(s)`);

  // Reclaim disk from clones left behind by a previous crashed run.
  // Must finish before polling starts — in-flight clones share the prefix.
  await cleanupStaleClones();

  startPolling(config.pollIntervalMin);
  startDiscordBot();
}

function shutdown(signal: string): void {
  logger.info(`Received ${signal}. Shutting down.`);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err: unknown) => {
  logger.error(`Fatal startup error: ${(err as Error).message}`);
  process.exit(1);
});
