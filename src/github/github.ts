/**
 * GitHub API client — uses REST API directly via axios.
 * No gh CLI required; authenticates with GH_TOKEN env var.
 */

import axios from 'axios';
import logger from '../utils/logger';
import { RateLimitError, isRateLimited, getRateLimitReset, createRetryFunction } from '../utils/errors';
import { PRDetails, InlineComment, ReviewEvent } from '../types';

const GH_API = 'https://api.github.com';

function getHeaders(): Record<string, string> {
  const token = process.env.GH_TOKEN;
  return {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'kungbi-pr-reviewer-bot',
  };
}

function checkRateLimit(headers: Record<string, string>): void {
  if (isRateLimited(headers)) {
    const resetAt = getRateLimitReset(headers);
    logger.warn(`Rate limit low. Remaining: ${headers['x-ratelimit-remaining']}, Resets at: ${resetAt}`);
    throw new RateLimitError('GitHub API rate limit low', resetAt);
  }
}

/**
 * Check if GH_TOKEN is set (replaces gh auth check)
 */
async function checkAuth(): Promise<boolean> {
  const token = process.env.GH_TOKEN;
  if (!token) return false;
  try {
    await axios.get(`${GH_API}/user`, { headers: getHeaders() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get PR details via REST API
 */
const getPRDetails = createRetryFunction(async (owner: unknown, repo: unknown, prNumber: unknown): Promise<PRDetails> => {
  logger.info(`Fetching PR details: ${owner}/${repo}#${prNumber}`);
  const res = await axios.get(
    `${GH_API}/repos/${owner}/${repo}/pulls/${prNumber}`,
    { headers: getHeaders() }
  );
  checkRateLimit(res.headers as Record<string, string>);
  const pr = res.data;
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    author: { login: pr.user?.login },
    url: pr.html_url,
    headRefName: pr.head?.ref,
    baseRefName: pr.base?.ref,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    labels: pr.labels,
    milestone: pr.milestone,
    reviewRequests: pr.requested_reviewers?.map((r: { login: string }) => ({ requestedReviewer: { login: r.login } })) ?? [],
    reviews: [],
  };
}, 3, 1000) as (owner: string, repo: string, prNumber: number) => Promise<PRDetails>;

/**
 * Get PR diff via REST API (returns raw diff text)
 */
const getPRDiff = createRetryFunction(async (owner: unknown, repo: unknown, prNumber: unknown): Promise<string> => {
  logger.info(`Fetching PR diff: ${owner}/${repo}#${prNumber}`);
  const res = await axios.get(
    `${GH_API}/repos/${owner}/${repo}/pulls/${prNumber}`,
    {
      headers: { ...getHeaders(), Accept: 'application/vnd.github.v3.diff' },
      responseType: 'text',
    }
  );
  return res.data as string;
}, 3, 1000) as (owner: string, repo: string, prNumber: number) => Promise<string>;

/**
 * Post a comment to a PR (issues/comments endpoint)
 */
const postComment = createRetryFunction(async (owner: unknown, repo: unknown, prNumber: unknown, body: unknown): Promise<unknown> => {
  logger.info(`Posting comment to ${owner}/${repo}#${prNumber}`);
  const res = await axios.post(
    `${GH_API}/repos/${owner}/${repo}/issues/${prNumber}/comments`,
    { body },
    { headers: getHeaders() }
  );
  checkRateLimit(res.headers as Record<string, string>);
  return res.data;
}, 3, 1000) as (owner: string, repo: string, prNumber: number, body: string) => Promise<unknown>;

/**
 * Post a review to a PR (APPROVE / REQUEST_CHANGES / COMMENT)
 */
const postReview = createRetryFunction(async (owner: unknown, repo: unknown, prNumber: unknown, body: unknown, event: unknown): Promise<unknown> => {
  logger.info(`Posting ${event} review to ${owner}/${repo}#${prNumber}`);
  const res = await axios.post(
    `${GH_API}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    { body, event },
    { headers: getHeaders() }
  );
  checkRateLimit(res.headers as Record<string, string>);
  return res.data;
}, 3, 1000) as (owner: string, repo: string, prNumber: number, body: string, event: ReviewEvent) => Promise<unknown>;

/**
 * Execute a GraphQL query
 */
const graphQLQuery = createRetryFunction(async (query: unknown, variables: unknown = {}): Promise<unknown> => {
  logger.info('Executing GraphQL query');
  const res = await axios.post(
    'https://api.github.com/graphql',
    { query, variables },
    { headers: getHeaders() }
  );
  checkRateLimit(res.headers as Record<string, string>);
  return res.data;
}, 3, 1000) as (query: string, variables?: Record<string, unknown>) => Promise<unknown>;

/**
 * Get the head commit SHA for a PR
 */
const getPRHeadSha = createRetryFunction(async (owner: unknown, repo: unknown, prNumber: unknown): Promise<string> => {
  const res = await axios.get(
    `${GH_API}/repos/${owner}/${repo}/pulls/${prNumber}`,
    { headers: getHeaders() }
  );
  checkRateLimit(res.headers as Record<string, string>);
  return res.data.head.sha as string;
}, 3, 1000) as (owner: string, repo: string, prNumber: number) => Promise<string>;

/**
 * Post an inline review with per-line comments.
 */
const _postInlineReviewRaw = createRetryFunction(async (owner: unknown, repo: unknown, prNumber: unknown, headSha: unknown, body: unknown, event: unknown, comments: unknown): Promise<unknown> => {
  const commentsArr = comments as InlineComment[];
  logger.info(`Posting inline review (${commentsArr.length} comments) to ${owner}/${repo}#${prNumber}`);
  const res = await axios.post(
    `${GH_API}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    { commit_id: headSha, body, event, comments },
    { headers: getHeaders() }
  );
  checkRateLimit(res.headers as Record<string, string>);
  return res.data;
}, 3, 1000) as (owner: string, repo: string, prNumber: number, headSha: string, body: string, event: ReviewEvent, comments: InlineComment[]) => Promise<unknown>;

/**
 * Post an inline review, falling back to COMMENT event if REQUEST_CHANGES/APPROVE
 * is rejected (e.g. when the reviewer is the PR author on own-repo test scenarios).
 */
async function postInlineReview(
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  body: string,
  event: ReviewEvent,
  comments: InlineComment[]
): Promise<unknown> {
  try {
    return await _postInlineReviewRaw(owner, repo, prNumber, headSha, body, event, comments);
  } catch (err) {
    const error = err as { response?: { status: number }; message?: string };
    const status = error.response?.status ?? (error.message?.includes('422') ? 422 : null);
    if (status === 422 && event !== 'COMMENT') {
      logger.warn(`[github] ${event} review rejected (422) — retrying as COMMENT`);
      return await _postInlineReviewRaw(owner, repo, prNumber, headSha, body, 'COMMENT', comments);
    }
    throw err;
  }
}

export {
  checkAuth,
  getPRDetails,
  getPRDiff,
  postComment,
  postReview,
  getPRHeadSha,
  postInlineReview,
  graphQLQuery,
};
