/**
 * Discord Notifier - Sends notifications to Discord via webhook
 */

import { DiscordEmbed, DiscordField, NotificationData } from './types';
import config from './utils/config';
import { sleep } from './utils/errors';

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

/**
 * Send a POST request to Discord webhook
 */
async function sendWebhook(payload: unknown): Promise<boolean> {
  if (!DISCORD_WEBHOOK_URL) {
    console.warn('[DISCORD] DISCORD_WEBHOOK_URL not set, skipping notification');
    return false;
  }

  let lastError: Error = new Error('No attempts made');

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        console.log(`[DISCORD] Notification sent successfully (attempt ${attempt})`);
        return true;
      }

      const text = await response.text();
      lastError = new Error(`Discord API error: ${response.status} - ${text}`);
      console.error(`[DISCORD] Attempt ${attempt} failed:`, lastError.message);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(`[DISCORD] Attempt ${attempt} failed:`, lastError.message);
    }

    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  console.error(`[DISCORD] All ${MAX_RETRIES} attempts failed. Last error:`, lastError.message);
  return false;
}

/**
 * Build a Discord embed for PR events
 */
function buildEmbed({ title, description, color, fields = [], url = '' }: {
  title: string;
  description: string;
  color: number;
  fields?: DiscordField[];
  url?: string;
}): DiscordEmbed {
  const embed: DiscordEmbed = {
    title,
    description,
    color,
    fields,
    timestamp: new Date().toISOString(),
    footer: {
      text: `🕷️ ${config.botName}`,
    },
  };

  if (url) {
    embed.url = url;
  }

  return embed;
}

/**
 * Main notification dispatcher
 */
async function sendDiscordNotification(event: string, data: NotificationData): Promise<boolean> {
  switch (event) {
    case 'pr_assigned':
      return sendPRAssignedNotification(data);
    case 'review_completed':
      return sendReviewCompletedNotification(data);
    case 'comment_needed':
      return sendCommentNeededNotification(data);
    default:
      console.warn(`[DISCORD] Unknown event type: ${event}`);
      return false;
  }
}

/**
 * Notify when a new PR is assigned to the bot
 */
async function sendPRAssignedNotification({ repoOwner, repoName, prNumber, prTitle, prUrl, action }: NotificationData): Promise<boolean> {
  const embed = buildEmbed({
    title: `🕷️ New PR Assigned - #${prNumber}`,
    description: `**${prTitle}**\nA new pull request has been assigned for review.`,
    color: 0x7C3AED, // Purple
    url: prUrl,
    fields: [
      { name: 'Repository', value: `${repoOwner}/${repoName}`, inline: true },
      { name: 'PR Number', value: `#${prNumber}`, inline: true },
      { name: 'Action', value: action || 'assigned', inline: true },
    ],
  });

  return sendWebhook({
    username: config.botName,
    avatar_url: config.botAvatarUrl,
    embeds: [embed],
  });
}

/**
 * Notify when a review is completed
 */
async function sendReviewCompletedNotification({ owner, repo, prNumber, prTitle, prAuthor = null, prHeadBranch = null, prBaseBranch = null, issuesFound = [] }: NotificationData): Promise<boolean> {
  const hasIssues = issuesFound && issuesFound.length > 0;

  let color: number;
  let statusEmoji: string;
  let statusText: string;

  if (!hasIssues) {
    color = 0x10B981; // Green
    statusEmoji = '✅';
    statusText = 'LGTM! No issues found.';
  } else {
    color = 0xEF4444; // Red
    statusEmoji = '⚠️';
    statusText = `${issuesFound!.length} issue(s) found`;
  }

  const prUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;
  const repoName = `${owner}/${repo}`;

  const fields: DiscordField[] = [
    { name: 'Repository', value: repoName, inline: true },
    { name: 'PR Number', value: `#${prNumber}`, inline: true },
  ];
  if (prAuthor) fields.push({ name: 'Author', value: `@${prAuthor}`, inline: true });
  if (prHeadBranch && prBaseBranch) fields.push({ name: 'Branch', value: `\`${prHeadBranch}\` → \`${prBaseBranch}\``, inline: false });

  if (hasIssues) {
    const issueList = issuesFound!
      .slice(0, 5)
      .map((issue, i) => `${i + 1}. ${issue}`)
      .join('\n');
    const moreText = issuesFound!.length > 5 ? `\n*...and ${issuesFound!.length - 5} more*` : '';
    fields.push({
      name: 'Issues Found',
      value: issueList + moreText,
      inline: false,
    });
  }

  const embed = buildEmbed({
    title: `${statusEmoji} Review Completed - #${prNumber}`,
    description: `**${prTitle}**\n${statusText}`,
    color,
    url: prUrl,
    fields,
  });

  return sendWebhook({
    username: config.botName,
    avatar_url: config.botAvatarUrl,
    embeds: [embed],
  });
}

/**
 * Notify when a reply is needed on a comment
 */
async function sendCommentNeededNotification({ repoOwner, repoName, prNumber, prTitle, prUrl, commenter }: NotificationData): Promise<boolean> {
  const embed = buildEmbed({
    title: `💬 Reply Needed - #${prNumber}`,
    description: `**@${commenter}** mentioned the bot and requires a reply on **${prTitle}**.`,
    color: 0xF59E0B, // Amber
    url: prUrl,
    fields: [
      { name: 'Repository', value: `${repoOwner}/${repoName}`, inline: true },
      { name: 'PR Number', value: `#${prNumber}`, inline: true },
      { name: 'Mentioned By', value: `@${commenter}`, inline: true },
    ],
  });

  return sendWebhook({
    username: config.botName,
    avatar_url: config.botAvatarUrl,
    embeds: [embed],
  });
}

/**
 * Notify when a review has started
 */
async function sendReviewStartedNotification({ owner, repo, prNumber, prTitle, prUrl, prAuthor = null, prHeadBranch = null, prBaseBranch = null }: NotificationData): Promise<boolean> {
  const fields: DiscordField[] = [
    { name: 'Repository', value: `${owner}/${repo}`, inline: true },
    { name: 'PR', value: `#${prNumber}`, inline: true },
  ];
  if (prAuthor) fields.push({ name: 'Author', value: `@${prAuthor}`, inline: true });
  if (prHeadBranch && prBaseBranch) fields.push({ name: 'Branch', value: `\`${prHeadBranch}\` → \`${prBaseBranch}\``, inline: false });

  const embed = buildEmbed({
    title: `🕷️ 리뷰 시작 - #${prNumber}`,
    description: `**${prTitle}**\nAI 리뷰가 시작되었습니다. 잠시 후 결과가 PR에 인라인 코멘트로 달립니다.`,
    color: 0x6366F1, // Indigo
    url: prUrl,
    fields,
  });

  return sendWebhook({
    username: config.botName,
    avatar_url: config.botAvatarUrl,
    embeds: [embed],
  });
}

export {
  sendDiscordNotification,
  sendPRAssignedNotification,
  sendReviewCompletedNotification,
  sendCommentNeededNotification,
  sendReviewStartedNotification,
};
