import { ReviewMemoryContext } from '../types';
import {
  buildReviewDraftPrompt,
  buildReviewVerificationPrompt,
  parseReviewDraft,
  ReviewDraft,
} from './review-draft';

export interface ReviewAgentSpawnOptions {
  cwd?: string;
  timeoutMs?: number;
}

export interface RunReviewVerificationGateArgs {
  owner: string;
  repo: string;
  prNumber: number;
  clonePath?: string;
  isReReview?: boolean;
  previousSha?: string | null;
  reviewMemory?: ReviewMemoryContext;
  spawn: (prompt: string, options?: ReviewAgentSpawnOptions) => Promise<string>;
  publish: (draft: ReviewDraft) => Promise<void>;
}

/**
 * Enforces the review quality gate: the first agent can only draft, then a
 * separate fresh agent session must validate the exact candidate before the
 * caller receives a publishable review.
 */
export async function runReviewVerificationGate(args: RunReviewVerificationGateArgs): Promise<ReviewDraft> {
  const promptParams = {
    owner: args.owner,
    repo: args.repo,
    prNumber: args.prNumber,
    clonePath: args.clonePath,
    isReReview: args.isReReview,
    previousSha: args.previousSha,
    reviewMemory: args.reviewMemory,
  };
  const spawnOptions = args.clonePath ? { cwd: args.clonePath } : undefined;

  const candidateOutput = await args.spawn(buildReviewDraftPrompt(promptParams), spawnOptions);
  const candidate = parseReviewDraft(candidateOutput);

  const verificationOutput = await args.spawn(
    buildReviewVerificationPrompt({ ...promptParams, candidate }),
    spawnOptions,
  );
  const verified = parseReviewDraft(verificationOutput);

  await args.publish(verified);
  return verified;
}
