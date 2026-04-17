
/**
 * Build the prompt for auto-replying to PR comments that mention the bot.
 */

interface CommentReplyParams {
  botName: string;
  owner: string;
  repo: string;
  prNumber: number;
  comment: {
    body: string;
    author?: { login?: string };
  };
}

export function buildCommentReplyPrompt({ botName, owner, repo, prNumber, comment }: CommentReplyParams): string {
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
