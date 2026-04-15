/**
 * Comment Monitor - Monitors PR comments and auto-replies to bot mentions
 */

const { execSync } = require('child_process');
const { sendDiscordNotification } = require('../notification/discord-notifier');
const path = require('path');
const ReviewedPRsState = require('../utils/state-manager');

const STATE_FILE = path.join(__dirname, '../../state/reviewed-prs.json');

/**
 * Get recent comments for a PR using gh pr view --comments
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number} prNumber - PR number
 * @returns {Array} Array of comment objects
 */
function getRecentComments(owner, repo, prNumber) {
  try {
    const output = execSync(
      `gh pr view ${prNumber} --repo ${owner}/${repo} --comments --json comments`,
      { encoding: 'utf-8' }
    );
    const data = JSON.parse(output);
    return data.comments || [];
  } catch (error) {
    console.error(`[ERROR] Failed to get comments for PR #${prNumber}:`, error.message);
    return [];
  }
}

/**
 * Filter comments where the bot is mentioned (@botname)
 * @param {Array} comments - Array of comment objects
 * @param {string} botName - Bot username (without @)
 * @returns {Array} Filtered comments mentioning the bot
 */
function filterBotMentions(comments, botName) {
  return comments.filter(comment => {
    const body = comment.body || '';
    const mentions = comment.bodyMentions?.mentions || [];

    // Check if bot is mentioned via @mentions or in body text
    return mentions.some(m => m.login === botName) ||
           body.includes(`@${botName}`);
  });
}

/**
 * Get parent comment context for a reply thread
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number} prNumber - PR number
 * @param {string} commentId - Parent comment ID
 * @returns {Object|null} Parent comment object or null
 */
function getParentComment(owner, repo, prNumber, commentId) {
  const comments = getRecentComments(owner, repo, prNumber);
  return comments.find(c => c.id === commentId) || null;
}

/**
 * Generate and post a reply to a comment using AI
 * @param {Object} comment - The comment object to reply to
 * @param {Object} context - Additional context for reply generation
 * @returns {Promise<string|null>} The generated reply body or null if failed
 */
async function generateAndPostReply(comment, context) {
  const { owner, repo, prNumber, botName } = context;
  const state = new ReviewedPRsState(STATE_FILE);

  // Check if already replied using state-manager
  if (state.isCommentReplied(comment.id)) {
    console.log(`[INFO] Already replied to comment ${comment.id}, skipping`);
    return null;
  }

  // Build context for AI generation
  const contextPrompt = `
You are ${botName}, a helpful PR reviewer bot for the ${owner}/${repo} repository.
Generate a friendly, helpful reply to the following comment:

Original Comment by ${comment.author?.login || 'unknown'}:
${comment.body}

PR: #${prNumber}
Repository: ${owner}/${repo}

Generate a concise, helpful reply that:
1. Addresses the question or feedback
2. Is friendly and professional
3. Does not exceed 500 characters
4. Is in Korean if the comment is in Korean, otherwise in English

Only output the reply body, nothing else.
`.trim();

  try {
    // Spawn a subagent to generate the reply using sessions_spawn
    const { sessions_spawn } = require('../utils/sessions-wrapper');
    const reply = await sessions_spawn(contextPrompt);

    if (!reply || reply.trim().length === 0) {
      console.error('[ERROR] Empty reply generated');
      return null;
    }

    // Post the reply via gh
    const parentCommentId = comment.id;
    const body = reply.trim();

    execSync(
      `gh api repos/${owner}/${repo}/pulls/${prNumber}/comments/${parentCommentId}/replies -f body="${body.replace(/"/g, '\\"')}"`,
      { encoding: 'utf-8' }
    );

    console.log(`[INFO] Posted reply to comment ${comment.id}`);
    state.markCommentReplied(comment.id);

    return body;
  } catch (error) {
    console.error(`[ERROR] Failed to generate/post reply:`, error.message);
    return null;
  }
}

/**
 * Check PR comments and reply to bot mentions
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number} prNumber - PR number
 * @returns {Promise<number>} Number of replies posted
 */
async function checkAndReply(owner, repo, prNumber) {
  const botName = process.env.BOT_NAME || 'kungbi-spider';

  console.log(`[INFO] Checking comments for PR #${prNumber} in ${owner}/${repo}`);

  // Get all comments
  const comments = getRecentComments(owner, repo, prNumber);
  console.log(`[INFO] Found ${comments.length} comments`);

  // Filter bot mentions
  const botMentions = filterBotMentions(comments, botName);
  console.log(`[INFO] Found ${botMentions.length} bot mentions`);

  // Check for already-replied comments using state-manager
  const state = new ReviewedPRsState(STATE_FILE);
  const newMentions = botMentions.filter(c => !state.isCommentReplied(c.id));
  console.log(`[INFO] ${newMentions.length} new mentions to reply to`);

  // Generate and post replies
  let replyCount = 0;
  for (const comment of newMentions) {
    const context = { owner, repo, prNumber, botName };
    
    // Send Discord notification for comment needing reply
    sendDiscordNotification('comment_needed', {
      repoOwner: owner,
      repoName: repo,
      prNumber,
      prTitle: `PR #${prNumber}`,
      prUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
      commenter: comment.author?.login || 'unknown',
      commentId: comment.id,
    }).catch(err => console.error('[ERROR] Failed to send Discord notification:', err.message));
    
    const result = await generateAndPostReply(comment, context);
    if (result) {
      replyCount++;
    }
  }

  console.log(`[INFO] Posted ${replyCount} replies`);
  return replyCount;
}

/**
 * Check all pending PRs for new comments that mention the bot
 * @returns {Promise<number>} Total number of replies posted across all PRs
 */
async function checkAllPendingPRs() {
  const state = new ReviewedPRsState(STATE_FILE);
  state.load();

  const pendingPRs = state.getPendingReplies();
  console.log(`[INFO] Checking ${pendingPRs.length} pending PRs for new comments`);

  let totalReplies = 0;

  for (const pr of pendingPRs) {
    try {
      const count = await checkAndReply(pr.owner, pr.repo, pr.prNumber);
      totalReplies += count;
    } catch (error) {
      console.error(`[ERROR] Failed to check PR ${pr.owner}/${pr.repo}#${pr.prNumber}:`, error.message);
    }
  }

  console.log(`[INFO] Total replies posted: ${totalReplies}`);
  return totalReplies;
}

module.exports = {
  getRecentComments,
  filterBotMentions,
  getParentComment,
  generateAndPostReply,
  checkAndReply,
  checkAllPendingPRs,
};
