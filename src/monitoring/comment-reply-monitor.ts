import logger from '../utils/logger';
import { ReviewComment } from '../types';

export type ReplyVerdict = 'REPLY_NEEDED' | 'NO_REPLY';

export interface ReplyDecision {
  verdict: ReplyVerdict;
  body?: string;
  reason?: string;
}

export interface JudgeReplyInput {
  owner: string;
  repo: string;
  prNumber: number;
  originalBotComment: ReviewComment;
  humanReply: ReviewComment;
}

export interface ReplyProcessingResult {
  scanned: number;
  candidates: number;
  replied: number;
  skipped: number;
}

interface ProcessReviewCommentRepliesArgs {
  owner: string;
  repo: string;
  prNumber: number;
  botLogin: string;
  comments: ReviewComment[];
  minReplyCreatedAt?: string | null;
  isCommentReplied: (commentId: string | number) => boolean;
  markCommentReplied: (commentId: string | number) => void;
  judgeAndDraftReply: (input: JudgeReplyInput) => Promise<ReplyDecision>;
  postReviewCommentReply: (
    owner: string,
    repo: string,
    prNumber: number,
    commentId: number,
    body: string,
  ) => Promise<unknown>;
}

function extractJsonObject(text: string): unknown | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue below.
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // Continue below.
    }
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeReplyDecision(value: unknown): ReplyDecision {
  if (!value || typeof value !== 'object') {
    return { verdict: 'NO_REPLY', reason: 'AI output was not a JSON object' };
  }
  const record = value as Record<string, unknown>;
  const verdict = record.verdict === 'REPLY_NEEDED' ? 'REPLY_NEEDED' : 'NO_REPLY';
  const body = typeof record.body === 'string' ? record.body.trim() : undefined;
  const reason = typeof record.reason === 'string' ? record.reason : undefined;

  if (verdict === 'REPLY_NEEDED' && body) {
    return { verdict, body, reason };
  }
  return { verdict: 'NO_REPLY', reason: reason ?? 'No substantive reply required' };
}

export async function judgeAndDraftReply(input: JudgeReplyInput): Promise<ReplyDecision> {
  const { owner, repo, prNumber, originalBotComment, humanReply } = input;
  const prompt = `You are the PR review bot follow-up responder.

Task:
Decide whether the human reply needs an answer from the bot. If yes, draft a concise, technically grounded reply in Korean unless the human wrote in English.

Rules:
- Reply only when the human asks a question, challenges the bot's finding, requests clarification, or provides evidence requiring a bot response.
- Do NOT reply to simple acknowledgements such as "thanks", "확인했습니다", "넵", reactions, or resolved/no-action notes.
- Do NOT be defensive. If the bot was wrong, acknowledge it clearly.
- Keep the reply short and specific. Do not invent facts outside the provided context.
- Return JSON only: {"verdict":"REPLY_NEEDED","body":"...","reason":"..."} or {"verdict":"NO_REPLY","reason":"..."}

PR: ${owner}/${repo}#${prNumber}

Original bot review comment:
${originalBotComment.body}

Original comment location:
path=${originalBotComment.path ?? '(unknown)'} line=${originalBotComment.line ?? '(unknown)'}

diff hunk:
${originalBotComment.diff_hunk ?? '(none)'}

Human reply by @${humanReply.user?.login ?? 'unknown'}:
${humanReply.body}
`;

  const { sessions_spawn } = await import('../utils/sessions_spawn');
  const output = await sessions_spawn(prompt);
  const parsed = extractJsonObject(output);
  return normalizeReplyDecision(parsed);
}

export async function processReviewCommentReplies(args: ProcessReviewCommentRepliesArgs): Promise<ReplyProcessingResult> {
  const comments = Array.isArray(args.comments) ? args.comments : [];
  const minReplyCreatedAtMs = args.minReplyCreatedAt ? new Date(args.minReplyCreatedAt).getTime() : null;
  const byId = new Map<number, ReviewComment>();
  for (const comment of comments) {
    byId.set(comment.id, comment);
  }

  const result: ReplyProcessingResult = {
    scanned: comments.length,
    candidates: 0,
    replied: 0,
    skipped: 0,
  };

  for (const humanReply of comments) {
    if (!humanReply.in_reply_to_id) continue;
    if (humanReply.user?.login === args.botLogin) continue;
    if (args.isCommentReplied(humanReply.id)) continue;
    if (minReplyCreatedAtMs !== null && Number.isFinite(minReplyCreatedAtMs)) {
      const replyCreatedAtMs = humanReply.created_at ? new Date(humanReply.created_at).getTime() : NaN;
      if (!Number.isFinite(replyCreatedAtMs) || replyCreatedAtMs < minReplyCreatedAtMs) continue;
    }

    const parent = byId.get(humanReply.in_reply_to_id);
    if (!parent || parent.user?.login !== args.botLogin) continue;

    result.candidates += 1;

    const decision = await args.judgeAndDraftReply({
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      originalBotComment: parent,
      humanReply,
    });

    if (decision.verdict === 'REPLY_NEEDED' && decision.body?.trim()) {
      await args.postReviewCommentReply(args.owner, args.repo, args.prNumber, parent.id, decision.body.trim());
      args.markCommentReplied(humanReply.id);
      result.replied += 1;
      logger.info(`[comment-reply-monitor] Replied to ${args.owner}/${args.repo}#${args.prNumber} comment ${humanReply.id}`);
    } else {
      args.markCommentReplied(humanReply.id);
      result.skipped += 1;
      logger.info(`[comment-reply-monitor] No reply needed for ${args.owner}/${args.repo}#${args.prNumber} comment ${humanReply.id}: ${decision.reason ?? 'no reason'}`);
    }
  }

  return result;
}
