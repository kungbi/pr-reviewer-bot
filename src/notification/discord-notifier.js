/**
 * Discord Notifier - Sends notifications to Discord via webhook
 */

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

/**
 * Sleep utility for retry delays
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Send a POST request to Discord webhook
 * @param {object} payload - Discord webhook payload
 * @returns {Promise<boolean>} Success status
 */
async function sendWebhook(payload) {
  if (!DISCORD_WEBHOOK_URL) {
    console.warn('[DISCORD] DISCORD_WEBHOOK_URL not set, skipping notification');
    return false;
  }

  let lastError;

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
      lastError = err;
      console.error(`[DISCORD] Attempt ${attempt} failed:`, err.message);
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
 * @param {string} title - Embed title
 * @param {string} description - Embed description
 * @param {number} color - Embed color (decimal)
 * @param {Array} fields - Array of {name, value, inline?} field objects
 * @param {string} url - Optional URL to link the title
 * @returns {object} Discord embed object
 */
function buildEmbed({ title, description, color, fields = [], url = '' }) {
  const embed = {
    title,
    description,
    color,
    fields,
    timestamp: new Date().toISOString(),
    footer: {
      text: '🕷️ Kungbi PR Reviewer Bot',
    },
  };

  if (url) {
    embed.url = url;
  }

  return embed;
}

/**
 * Main notification dispatcher
 * @param {string} event - Event type: 'pr_assigned' | 'review_completed' | 'comment_needed'
 * @param {object} data - Event-specific data
 * @returns {Promise<boolean>} Success status
 */
async function sendDiscordNotification(event, data) {
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
 * @param {object} data - { repoOwner, repoName, prNumber, prTitle, prUrl, action }
 * @returns {Promise<boolean>}
 */
async function sendPRAssignedNotification({ repoOwner, repoName, prNumber, prTitle, prUrl, action }) {
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
    username: 'Kungbi PR Reviewer',
    avatar_url: 'https://github.com/kungbi-spider.png',
    embeds: [embed],
  });
}

/**
 * Notify when a review is completed
 * @param {object} data - { owner, repo, prNumber, prTitle, issuesFound }
 * @returns {Promise<boolean>}
 */
async function sendReviewCompletedNotification({ owner, repo, prNumber, prTitle, prAuthor = null, prHeadBranch = null, prBaseBranch = null, issuesFound = [] }) {
  // Determine embed color based on issues
  const hasIssues = issuesFound && issuesFound.length > 0;

  let color;
  let statusEmoji;
  let statusText;

  if (!hasIssues) {
    color = 0x10B981; // Green
    statusEmoji = '✅';
    statusText = 'LGTM! No issues found.';
  } else {
    color = 0xEF4444; // Red
    statusEmoji = '⚠️';
    statusText = `${issuesFound.length} issue(s) found`;
  }

  const prUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;
  const repoName = `${owner}/${repo}`;

  // Build fields
  const fields = [
    { name: 'Repository', value: repoName, inline: true },
    { name: 'PR Number', value: `#${prNumber}`, inline: true },
  ];
  if (prAuthor) fields.push({ name: 'Author', value: `@${prAuthor}`, inline: true });
  if (prHeadBranch && prBaseBranch) fields.push({ name: 'Branch', value: `\`${prHeadBranch}\` → \`${prBaseBranch}\``, inline: false });

  // Add issues as a field if found
  if (hasIssues) {
    const issueList = issuesFound
      .slice(0, 5)
      .map((issue, i) => `${i + 1}. ${issue}`)
      .join('\n');
    const moreText = issuesFound.length > 5 ? `\n*...and ${issuesFound.length - 5} more*` : '';
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
    username: 'Kungbi PR Reviewer',
    avatar_url: 'https://github.com/kungbi-spider.png',
    embeds: [embed],
  });
}

/**
 * Notify when a reply is needed on a comment
 * @param {object} data - { repoOwner, repoName, prNumber, prTitle, prUrl, commenter, commentId }
 * @returns {Promise<boolean>}
 */
async function sendCommentNeededNotification({ repoOwner, repoName, prNumber, prTitle, prUrl, commenter, commentId }) {
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
    username: 'Kungbi PR Reviewer',
    avatar_url: 'https://github.com/kungbi-spider.png',
    embeds: [embed],
  });
}

/**
 * Notify when a review has started (replaces GitHub "PR Review Started" comment)
 * @param {object} data - { owner, repo, prNumber, prTitle, prUrl }
 * @returns {Promise<boolean>}
 */
async function sendReviewStartedNotification({ owner, repo, prNumber, prTitle, prUrl, prAuthor = null, prHeadBranch = null, prBaseBranch = null }) {
  const fields = [
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
    username: 'Kungbi PR Reviewer',
    avatar_url: 'https://github.com/kungbi-spider.png',
    embeds: [embed],
  });
}

module.exports = {
  sendDiscordNotification,
  sendPRAssignedNotification,
  sendReviewCompletedNotification,
  sendCommentNeededNotification,
  sendReviewStartedNotification,
};
