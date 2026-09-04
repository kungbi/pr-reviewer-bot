import 'dotenv/config';
import logger from './utils/logger';
import config from './utils/config';
import { PollingController, startPolling } from './poller';
import { startDiscordBot } from './discord-bot';
import { cleanupStaleClones } from './review/repo-cloner';
import { getSharedRepositoryCache } from './review/repository-cache';
import { beginReviewDrain, waitForReviewDrain } from './review/review-executor';

let pollingController: PollingController | undefined;
let shutdownStarted = false;

async function main(): Promise<void> {
  logger.info(`=== ${config.botName} PR Reviewer Bot (polling mode) ===`);
  logger.info(`Poll interval: every ${config.pollIntervalMin} minute(s)`);

  // Reclaim disk from clones left behind by a previous crashed run.
  // Must finish before polling starts — in-flight clones share the prefix.
  await cleanupStaleClones();

  if (config.repositoryCacheEnabled) {
    logger.info('[repository-cache] Discovering and synchronizing every repository visible to GH_TOKEN...');
    const summary = await getSharedRepositoryCache().syncAll();
    logger.info(
      `[repository-cache] Sync complete: total=${summary.total}, cloned=${summary.cloned}, ` +
      `updated=${summary.updated}, failed=${summary.failed.length}`,
    );
    if (summary.failed.length > 0) {
      throw new Error(`Repository cache startup sync failed for ${summary.failed.length} repository/repositories`);
    }
  }

  pollingController = startPolling(config.pollIntervalMin);
  startDiscordBot();
}

async function shutdown(signal: string): Promise<void> {
  if (shutdownStarted) {
    logger.warn(`Received ${signal} while shutdown is already in progress.`);
    return;
  }
  shutdownStarted = true;
  logger.info(`Received ${signal}. Draining in-flight review work for up to ${config.shutdownGraceMs / 60_000} minute(s).`);

  beginReviewDrain();
  const [pollerResult, reviewResult] = await Promise.all([
    pollingController?.stop(config.shutdownGraceMs) ?? Promise.resolve({ drained: true, activeCount: 0 }),
    waitForReviewDrain(config.shutdownGraceMs),
  ]);
  const drained = pollerResult.drained && reviewResult.drained;
  if (drained) {
    logger.info('Graceful shutdown complete; all in-flight work settled.');
  } else {
    logger.error(`Graceful shutdown timed out with poll ticks=${pollerResult.activeCount}, reviews=${reviewResult.activeCount}.`);
  }
  process.exit(drained ? 0 : 1);
}
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

main().catch((err: unknown) => {
  logger.error(`Fatal startup error: ${(err as Error).message}`);
  process.exit(1);
});
