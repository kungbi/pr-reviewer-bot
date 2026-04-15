/**
 * GitHub API client — uses REST API directly via axios.
 * No gh CLI required; authenticates with GH_TOKEN env var.
 */

const axios = require('axios');
const logger = require('./logger');
const { RateLimitError, isRateLimited, getRateLimitReset, createRetryFunction } = require('./errors');

const GH_API = 'https://api.github.com';

function getHeaders() {
  const token = process.env.GH_TOKEN;
  return {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'kungbi-pr-reviewer-bot',
  };
}

function checkRateLimit(headers) {
  if (isRateLimited(headers)) {
    const resetAt = getRateLimitReset(headers);
    logger.warn(`Rate limit low. Remaining: ${headers['x-ratelimit-remaining']}, Resets at: ${resetAt}`);
    throw new RateLimitError('GitHub API rate limit low', resetAt);
  }
}

/**
 * Check if GH_TOKEN is set (replaces gh auth check)
 * @returns {Promise<boolean>}
 */
async function checkAuth() {
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
const getPRDetails = createRetryFunction(async (owner, repo, prNumber) => {
  logger.info(`Fetching PR details: ${owner}/${repo}#${prNumber}`);
  const res = await axios.get(
    `${GH_API}/repos/${owner}/${repo}/pulls/${prNumber}`,
    { headers: getHeaders() }
  );
  checkRateLimit(res.headers);
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
    reviewRequests: pr.requested_reviewers?.map(r => ({ requestedReviewer: { login: r.login } })) ?? [],
    reviews: [],
  };
}, 3, 1000);

/**
 * Get PR diff via REST API (returns raw diff text)
 */
const getPRDiff = createRetryFunction(async (owner, repo, prNumber) => {
  logger.info(`Fetching PR diff: ${owner}/${repo}#${prNumber}`);
  const res = await axios.get(
    `${GH_API}/repos/${owner}/${repo}/pulls/${prNumber}`,
    {
      headers: { ...getHeaders(), Accept: 'application/vnd.github.v3.diff' },
      responseType: 'text',
    }
  );
  return res.data;
}, 3, 1000);

/**
 * Post a comment to a PR (issues/comments endpoint)
 */
const postComment = createRetryFunction(async (owner, repo, prNumber, body) => {
  logger.info(`Posting comment to ${owner}/${repo}#${prNumber}`);
  const res = await axios.post(
    `${GH_API}/repos/${owner}/${repo}/issues/${prNumber}/comments`,
    { body },
    { headers: getHeaders() }
  );
  checkRateLimit(res.headers);
  return res.data;
}, 3, 1000);

/**
 * Post a review to a PR (APPROVE / REQUEST_CHANGES / COMMENT)
 */
const postReview = createRetryFunction(async (owner, repo, prNumber, body, event) => {
  logger.info(`Posting ${event} review to ${owner}/${repo}#${prNumber}`);
  const res = await axios.post(
    `${GH_API}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    { body, event },
    { headers: getHeaders() }
  );
  checkRateLimit(res.headers);
  return res.data;
}, 3, 1000);

/**
 * Execute a GraphQL query
 */
const graphQLQuery = createRetryFunction(async (query, variables = {}) => {
  logger.info('Executing GraphQL query');
  const res = await axios.post(
    'https://api.github.com/graphql',
    { query, variables },
    { headers: getHeaders() }
  );
  checkRateLimit(res.headers);
  return res.data;
}, 3, 1000);

/**
 * Get the head commit SHA for a PR
 */
const getPRHeadSha = createRetryFunction(async (owner, repo, prNumber) => {
  const res = await axios.get(
    `${GH_API}/repos/${owner}/${repo}/pulls/${prNumber}`,
    { headers: getHeaders() }
  );
  checkRateLimit(res.headers);
  return res.data.head.sha;
}, 3, 1000);

/**
 * Post an inline review with per-line comments.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {number} prNumber
 * @param {string} headSha - Head commit SHA (required by GitHub API)
 * @param {string} body - Overall review body
 * @param {string} event - APPROVE | REQUEST_CHANGES | COMMENT
 * @param {Array<{path: string, position: number, body: string}>} comments
 */
const _postInlineReviewRaw = createRetryFunction(async (owner, repo, prNumber, headSha, body, event, comments) => {
  logger.info(`Posting inline review (${comments.length} comments) to ${owner}/${repo}#${prNumber}`);
  const res = await axios.post(
    `${GH_API}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    { commit_id: headSha, body, event, comments },
    { headers: getHeaders() }
  );
  checkRateLimit(res.headers);
  return res.data;
}, 3, 1000);

/**
 * Post an inline review, falling back to COMMENT event if REQUEST_CHANGES/APPROVE
 * is rejected (e.g. when the reviewer is the PR author on own-repo test scenarios).
 */
async function postInlineReview(owner, repo, prNumber, headSha, body, event, comments) {
  try {
    return await _postInlineReviewRaw(owner, repo, prNumber, headSha, body, event, comments);
  } catch (err) {
    const status = err.response?.status ?? (err.message?.includes('422') ? 422 : null);
    if (status === 422 && event !== 'COMMENT') {
      logger.warn(`[github] ${event} review rejected (422) — retrying as COMMENT`);
      return await _postInlineReviewRaw(owner, repo, prNumber, headSha, body, 'COMMENT', comments);
    }
    throw err;
  }
}

module.exports = {
  checkAuth,
  getPRDetails,
  getPRDiff,
  postComment,
  postReview,
  getPRHeadSha,
  postInlineReview,
  graphQLQuery,
};
