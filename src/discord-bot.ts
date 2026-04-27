import { Client, GatewayIntentBits, Message } from 'discord.js';
import { executeReview } from './review/review-executor';
import logger from './utils/logger';
import config from './utils/config';

const PR_URL_REGEX = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/g;

export function startDiscordBot(): void {
  const token = config.discordBotToken;
  const channelId = config.discordChannelId;

  if (!token || !channelId) {
    logger.warn('[DISCORD-BOT] DISCORD_BOT_TOKEN or DISCORD_CHANNEL_ID not set, skipping bot');
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.on('ready', () => {
    logger.info(`[DISCORD-BOT] Logged in as ${client.user?.tag}, watching channel ${channelId}`);
  });

  client.on('messageCreate', async (message: Message) => {
    if (message.author.bot) return;
    if (message.channelId !== channelId) return;

    const matches = [...message.content.matchAll(PR_URL_REGEX)];
    if (matches.length === 0) return;

    for (const match of matches) {
      const [, owner, repo, prNumberStr] = match;
      const prNumber = parseInt(prNumberStr, 10);
      const label = `${owner}/${repo}#${prNumber}`;

      logger.info(`[DISCORD-BOT] Manual review triggered: ${label}`);
      await message.reply(`🔍 리뷰 시작합니다: **${label}**`);

      try {
        const result = await executeReview(owner, repo, prNumber);
        if (result.verdict === 'already_reviewed') {
          await message.reply(`ℹ️ 이미 리뷰된 PR입니다: **${label}**`);
        } else if (result.success) {
          await message.reply(`✅ 리뷰 완료: **${label}** (${result.verdict})`);
        } else {
          await message.reply(`❌ 리뷰 실패: **${label}**\n${result.error ?? ''}`);
        }
      } catch (err) {
        const error = err as Error;
        logger.error(`[DISCORD-BOT] Review error for ${label}: ${error.message}`);
        await message.reply(`❌ 오류 발생: ${error.message}`);
      }
    }
  });

  client.login(token).catch((err: Error) => {
    logger.error(`[DISCORD-BOT] Login failed: ${err.message}`);
  });
}
