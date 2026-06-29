/**
 * Discord Notifier - Sends notifications to Discord via webhook
 */

import { DiscordEmbed, DiscordField, NotificationData } from './types';
import config from './utils/config';
import { sleep } from './utils/errors';

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

function truncateDiscordField(value: string | undefined | null, max = 1000): string {
  const text = (value ?? '').trim();
  if (!text) return '(empty)';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

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
    case 'review_comment_reply':
      return sendReviewCommentReplyNotification(data);
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
 * Notify when a human replies to the bot's review comment, or when the bot posts
 * an additional answer in that same review thread.
 */
async function sendReviewCommentReplyNotification(data: NotificationData): Promise<boolean> {
  const {
    owner,
    repo,
    repoOwner,
    repoName,
    prNumber,
    prTitle,
    commenter,
    commentId,
    parentCommentId,
    commentBody,
    botReplyBody,
    commentUrl,
    replyUrl,
    replyAction,
  } = data;
  const repoLabel = owner && repo ? `${owner}/${repo}` : `${repoOwner}/${repoName}`;
  const prUrl = `https://github.com/${repoLabel}/pull/${prNumber}`;
  const isBotReply = replyAction === 'bot_replied';
  const fields: DiscordField[] = [
    { name: 'Repository', value: repoLabel, inline: true },
    { name: 'PR', value: `#${prNumber}`, inline: true },
  ];

  if (commenter) fields.push({ name: 'Commenter', value: `@${commenter}`, inline: true });
  if (commentId) fields.push({ name: 'Human Reply ID', value: String(commentId), inline: true });
  if (parentCommentId) fields.push({ name: 'Parent Bot Comment ID', value: String(parentCommentId), inline: true });
  if (commentBody) fields.push({ name: 'Human Reply', value: truncateDiscordField(commentBody), inline: false });
  if (botReplyBody) fields.push({ name: 'Bot Reply', value: truncateDiscordField(botReplyBody), inline: false });
  if (commentUrl) fields.push({ name: 'Human Reply URL', value: commentUrl, inline: false });
  if (replyUrl) fields.push({ name: 'Bot Reply URL', value: replyUrl, inline: false });

  const embed = buildEmbed({
    title: isBotReply ? `🤖 봇 답글 게시 - #${prNumber}` : `💬 리뷰 댓글 답글 감지 - #${prNumber}`,
    description: isBotReply
      ? `**${prTitle || repoLabel}**\n봇이 review comment thread에 추가 답변을 게시했습니다.`
      : `**${prTitle || repoLabel}**\n@${commenter || 'unknown'} 님이 봇 review comment에 답글을 달았습니다.`,
    color: isBotReply ? 0x2563EB : 0xF59E0B,
    url: replyUrl || commentUrl || prUrl,
    fields,
  });

  return sendWebhook({
    username: config.botName,
    avatar_url: config.botAvatarUrl,
    embeds: [embed],
  });
}

/**
 * Notify when a review has failed or been permanently skipped
 */
async function sendReviewFailedNotification({ owner, repo, prNumber, prTitle, prAuthor = null, prHeadBranch = null, prBaseBranch = null, errorMessage, permanentlySkipped = false }: NotificationData & { errorMessage?: string; permanentlySkipped?: boolean }): Promise<boolean> {
  const prUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;

  const title = permanentlySkipped
    ? `🚫 리뷰 영구 스킵 - #${prNumber}`
    : `❌ 리뷰 실패 - #${prNumber}`;

  const description = permanentlySkipped
    ? `**${prTitle}**\n최대 재시도 횟수를 초과하여 리뷰가 영구적으로 스킵되었습니다.`
    : `**${prTitle}**\n리뷰 중 오류가 발생했습니다.`;

  const fields: DiscordField[] = [
    { name: 'Repository', value: `${owner}/${repo}`, inline: true },
    { name: 'PR Number', value: `#${prNumber}`, inline: true },
  ];
  if (prAuthor) fields.push({ name: 'Author', value: `@${prAuthor}`, inline: true });
  if (prHeadBranch && prBaseBranch) fields.push({ name: 'Branch', value: `\`${prHeadBranch}\` → \`${prBaseBranch}\``, inline: false });
  if (errorMessage) fields.push({ name: 'Error', value: errorMessage.slice(0, 1024), inline: false });

  const embed = buildEmbed({
    title,
    description,
    color: permanentlySkipped ? 0x6B7280 : 0xF97316, // Gray for skipped, Orange for failed
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
  sendReviewCommentReplyNotification,
  sendReviewStartedNotification,
  sendReviewFailedNotification,
};
