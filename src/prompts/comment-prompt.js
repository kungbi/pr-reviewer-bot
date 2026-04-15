'use strict';

/**
 * Build the prompt for auto-replying to PR comments that mention the bot.
 *
 * @param {object} params
 * @param {string} params.botName
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {number} params.prNumber
 * @param {object} params.comment - { body, author: { login } }
 * @returns {string} Prompt string
 */
function buildCommentReplyPrompt({ botName, owner, repo, prNumber, comment }) {
  return `
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
}

module.exports = { buildCommentReplyPrompt };
