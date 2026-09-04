import { ReviewMemoryContext } from '../types';
import config from '../utils/config';
import { sleep } from '../utils/errors';
import logger from '../utils/logger';
import { ModelCapacityError } from '../utils/sessions_spawn';
import {
  buildPonytailReviewPrompt,
  buildReviewDraftPrompt,
  buildReviewVerificationPrompt,
  mergeReviewDrafts,
  parsePonytailReviewDraft,
  parseReviewDraft,
  ReviewDraft,
  validateVerifiedPonytailFindings,
  validateVerifiedProposalFindings,
} from './review-draft';
import {
  buildRepositorySelectionPrompt,
  parseRepositorySelection,
  RepositoryCatalogEntry,
} from './repository-selection';

export interface ReviewAgentSpawnOptions {
  cwd?: string;
  timeoutMs?: number;
}

export interface ModelCapacityRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const MODEL_CAPACITY_MAX_ATTEMPTS = 3;
const MODEL_CAPACITY_BASE_DELAY_MS = 10_000;

/**
 * Retries only a provider-transient capacity failure. It deliberately does not
 * catch malformed output, policy failures, or any other semantic review error.
 */
export async function runModelCapacityRetry<T>(
  stage: 'selector' | 'primary' | 'ponytail' | 'verifier',
  invoke: () => Promise<T>,
  options: ModelCapacityRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? MODEL_CAPACITY_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? MODEL_CAPACITY_BASE_DELAY_MS;
  const sleepFn = options.sleep ?? sleep;
  const random = options.random ?? Math.random;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await invoke();
    } catch (error) {
      if (!(error instanceof ModelCapacityError)) throw error;
      if (attempt === maxAttempts) {
        throw new ModelCapacityError(error.detail, stage, attempt);
      }

      const boundedRandom = Math.max(0, Math.min(1, random()));
      const delayMs = Math.round(baseDelayMs * (2 ** (attempt - 1)) * (1 + boundedRandom * 0.2));
      const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
      logger.warn(
        `[ReviewVerificationGate] capacity retry: stage=${stage}, attempt=${attempt}/${maxAttempts}, ` +
        `nextRetryAt=${nextRetryAt}, model=${config.reviewModel ?? 'default'}, ` +
        `reasoning=${config.codexReasoningEffort ?? 'default'}, fallbackAllowed=false`
      );
      await sleepFn(delayMs);
    }
  }

  throw new Error('unreachable model capacity retry state');
}

export interface RunReviewVerificationGateArgs {
  owner: string;
  repo: string;
  prNumber: number;
  clonePath?: string;
  isReReview?: boolean;
  previousSha?: string | null;
  reviewMemory?: ReviewMemoryContext;
  baseBranch?: string;
  repositoryCatalog?: RepositoryCatalogEntry[];
  repositoryCatalogPath?: string;
  refreshSelectedRepositories?: (fullNames: string[]) => Promise<void>;
  capacityRetry?: ModelCapacityRetryOptions;
  spawn: (prompt: string, options?: ReviewAgentSpawnOptions) => Promise<string>;
  publish: (draft: ReviewDraft) => Promise<void>;
}

/**
 * Enforces the review quality gate: the first agent can only draft, then a
 * separate fresh agent session must validate the exact candidate before the
 * caller receives a publishable review.
 */
export async function runReviewVerificationGate(args: RunReviewVerificationGateArgs): Promise<ReviewDraft> {
  let repositoryContext;
  if (args.clonePath && args.repositoryCatalog?.length && args.repositoryCatalogPath) {
    const selectionOutput = await runModelCapacityRetry(
      'selector',
      () => args.spawn(buildRepositorySelectionPrompt({
        owner: args.owner,
        repo: args.repo,
        prNumber: args.prNumber,
        clonePath: args.clonePath as string,
        baseBranch: args.baseBranch ?? 'unknown',
        catalog: args.repositoryCatalog as RepositoryCatalogEntry[],
        catalogPath: args.repositoryCatalogPath as string,
      }), { cwd: args.clonePath }),
      args.capacityRetry,
    );
    repositoryContext = parseRepositorySelection(
      selectionOutput,
      args.repositoryCatalog,
      {
        owner: args.owner,
        repo: args.repo,
        clonePath: args.clonePath,
        baseBranch: args.baseBranch ?? 'unknown',
      },
    );
    const siblings = repositoryContext
      .filter((repository) => !repository.target)
      .map((repository) => repository.fullName);
    if (siblings.length > 0 && args.refreshSelectedRepositories) {
      await args.refreshSelectedRepositories(siblings);
    }
  }

  const promptParams = {
    owner: args.owner,
    repo: args.repo,
    prNumber: args.prNumber,
    clonePath: args.clonePath,
    isReReview: args.isReReview,
    previousSha: args.previousSha,
    reviewMemory: args.reviewMemory,
    baseBranch: args.baseBranch,
    repositoryContext,
    repositoryCatalogPath: args.repositoryCatalogPath,
  };
  const spawnOptions = args.clonePath ? { cwd: args.clonePath } : undefined;

  const primaryOutput = await runModelCapacityRetry(
    'primary',
    () => args.spawn(buildReviewDraftPrompt(promptParams), spawnOptions),
    args.capacityRetry,
  );
  const primaryCandidate = parseReviewDraft(primaryOutput);

  const ponytailOutput = await runModelCapacityRetry(
    'ponytail',
    () => args.spawn(buildPonytailReviewPrompt(promptParams), spawnOptions),
    args.capacityRetry,
  );
  const ponytailCandidate = parsePonytailReviewDraft(ponytailOutput);
  const candidate = mergeReviewDrafts(primaryCandidate, ponytailCandidate);

  const verificationOutput = await runModelCapacityRetry(
    'verifier',
    () => args.spawn(buildReviewVerificationPrompt({ ...promptParams, candidate }), spawnOptions),
    args.capacityRetry,
  );
  const verifiedDraft = validateVerifiedProposalFindings(
    parseReviewDraft(verificationOutput),
    candidate,
  );
  const verified = validateVerifiedPonytailFindings(verifiedDraft, candidate);

  await args.publish(verified);
  return verified;
}
