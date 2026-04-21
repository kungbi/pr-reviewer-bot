import { execSync } from 'child_process';
import path from 'path';
import { sendDiscordNotification } from '../notification/discord-notifier';
import { buildCommentReplyPrompt } from '../prompts/comment-prompt';
import ReviewedPRsState from '../utils/state-manager';
import { sessions_spawn } from '../utils/sessions-wrapper';

const STATE_FILE = path.join(__dirname, '../../state/reviewed-prs.json');

interface GHComment {
  id: string;
  body: string;
  author?: { login?: string };
  bodyMentions?: { mentions?: Array<{ login: string }> };
}

interface ReplyContext {
  owner: string;
  repo: string;
  prNumber: number;
  botName: string;
}

function getRecentComments(owner: string, repo: string, prNumber: number): GHComment[] {
  try {
    const output = execSync(
      `gh pr view ${prNumber} --repo ${owner}/${repo} --comments --json comments`,
      { encoding: 'utf-8' }
    );
    const data = JSON.parse(output) as { comments?: GHComment[] };
    return data.comments ?? [];
  } catch (error) {
    console.error(`[ERROR] Failed to get comments for PR #${prNumber}:`, (error as Error).message);
    return [];
  }
}

function filterBotMentions(comments: GHComment[], botName: string): GHComment[] {
  return comments.filter(comment => {
    const body = comment.body ?? '';
    const mentions = comment.bodyMentions?.mentions ?? [];
    return mentions.some(m => m.login === botName) || body.includes(`@${botName}`);
  });
}

function getParentComment(owner: string, repo: string, prNumber: number, commentId: string): GHComment | null {
  const comments = getRecentComments(owner, repo, prNumber);
  return comments.find(c => c.id === commentId) ?? null;
}

async function generateAndPostReply(comment: GHComment, context: ReplyContext): Promise<string | null> {
  const { owner, repo, prNumber, botName } = context;
  const state = new ReviewedPRsState(STATE_FILE);

  if (state.isCommentReplied(comment.id)) {
    console.log(`[INFO] Already replied to comment ${comment.id}, skipping`);
    return null;
  }

  const prompt = buildCommentReplyPrompt({ botName, owner, repo, prNumber, comment });

  try {
    const reply = await sessions_spawn(prompt);

    if (!reply || reply.trim().length === 0) {
      console.error('[ERROR] Empty reply generated');
      return null;
    }

    const body = reply.trim();
    execSync(
      `gh api repos/${owner}/${repo}/pulls/${prNumber}/comments/${comment.id}/replies -f body="${body.replace(/"/g, '\\"')}"`,
      { encoding: 'utf-8' }
    );

    console.log(`[INFO] Posted reply to comment ${comment.id}`);
    state.markCommentReplied(comment.id);

    return body;
  } catch (error) {
    console.error('[ERROR] Failed to generate/post reply:', (error as Error).message);
    return null;
  }
}

async function checkAndReply(owner: string, repo: string, prNumber: number): Promise<number> {
  const botName = process.env.BOT_NAME ?? 'kungbi-spider';

  console.log(`[INFO] Checking comments for PR #${prNumber} in ${owner}/${repo}`);

  const comments = getRecentComments(owner, repo, prNumber);
  console.log(`[INFO] Found ${comments.length} comments`);

  const botMentions = filterBotMentions(comments, botName);
  console.log(`[INFO] Found ${botMentions.length} bot mentions`);

  const state = new ReviewedPRsState(STATE_FILE);
  const newMentions = botMentions.filter(c => !state.isCommentReplied(c.id));
  console.log(`[INFO] ${newMentions.length} new mentions to reply to`);

  let replyCount = 0;
  for (const comment of newMentions) {
    sendDiscordNotification('comment_needed', {
      repoOwner: owner,
      repoName: repo,
      prNumber,
      prTitle: `PR #${prNumber}`,
      prUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
      commenter: comment.author?.login ?? 'unknown',
      commentId: comment.id,
    }).catch((err: unknown) => console.error('[ERROR] Failed to send Discord notification:', (err as Error).message));

    const result = await generateAndPostReply(comment, { owner, repo, prNumber, botName });
    if (result) replyCount++;
  }

  console.log(`[INFO] Posted ${replyCount} replies`);
  return replyCount;
}

async function checkAllPendingPRs(): Promise<number> {
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
      console.error(`[ERROR] Failed to check PR ${pr.owner}/${pr.repo}#${pr.prNumber}:`, (error as Error).message);
    }
  }

  console.log(`[INFO] Total replies posted: ${totalReplies}`);
  return totalReplies;
}

export {
  getRecentComments,
  filterBotMentions,
  getParentComment,
  generateAndPostReply,
  checkAndReply,
  checkAllPendingPRs,
};
