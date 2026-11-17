import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import ReviewedPRsState, { getSharedState } from '../src/utils/state-manager';
import { executeReview } from '../src/review/review-executor';
import { getPRHeadSha, postComment } from '../src/github';
import { sendReviewFailedNotification } from '../src/discord-notifier';
import { pollAssignedPRs } from '../src/poller';
import { executeReviewWithRetry } from '../src/review/polling-reviewer';

jest.mock('axios');
jest.mock('../src/utils/state-manager', () => ({ __esModule: true, ...jest.requireActual('../src/utils/state-manager'), getSharedState: jest.fn() }));
jest.mock('../src/github', () => ({ getPRHeadSha: jest.fn(), postComment: jest.fn() }));
jest.mock('../src/discord-notifier', () => ({ sendReviewFailedNotification: jest.fn() }));
jest.mock('../src/review/review-executor', () => ({ executeReview: jest.fn(), isReviewDraining: () => false }));
jest.mock('../src/review/review-report-outbox', () => ({ ...jest.requireActual('../src/review/review-report-outbox'), listReportOutbox: () => [], readReportOutbox: () => null }));

import { startDiscordBot } from '../src/discord-bot';
import config from '../src/utils/config';

const mockHandlers: Record<string, (...args: any[]) => any> = {};
jest.mock('discord.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    on: (event: string, handler: (...args: any[]) => any) => { mockHandlers[event] = handler; },
    login: () => Promise.resolve(),
  })),
  GatewayIntentBits: {},
}));

const head = 'cae2999e7220b9d6380afb14c4fa387752dae733';
const next = 'b'.repeat(40);
const info = { owner: 'specup', repo: 'timespread-api-nest', prNumber: 1471, title: 'regression' };
const key = 'specup/timespread-api-nest#1471';
let dir: string;
let file: string;
let state: ReviewedPRsState;
function restart() { state = new ReviewedPRsState(file); state.load(); (getSharedState as jest.Mock).mockReturnValue(state); }
function seed(count: number, revision: string | null = head, status = 'skipped') {
  fs.writeFileSync(file, JSON.stringify({ reviewedPRs: { [key]: { ...info, status, retryCount: count, reviewingHeadSha: revision } }, repliedComments: {} }));
  restart();
}
async function polls(n: number) { for (let i = 0; i < n; i++) await pollAssignedPRs(); }
beforeEach(() => {
  jest.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-spam-'));
  file = path.join(dir, 'state.json'); restart();
  (getPRHeadSha as jest.Mock).mockResolvedValue(head);
  (axios.get as jest.Mock).mockResolvedValue({ data: { items: [{ number: info.prNumber, title: info.title, html_url: `https://github.com/${info.owner}/${info.repo}/pull/${info.prNumber}` }] } });
  (executeReview as jest.Mock).mockRejectedValue(new Error('analysis failed'));
  (postComment as jest.Mock).mockResolvedValue(undefined);
});
afterEach(() => { jest.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

test('real poller -> retry wrapper -> durable state stops at three and survives restart', async () => {
  await polls(6); restart(); await polls(4);
  expect(executeReview).toHaveBeenCalledTimes(3);
  expect(postComment).toHaveBeenCalledTimes(1);
  expect(state.getPRRetryCount(info.owner, info.repo, info.prNumber)).toBe(3);
});

test.each(['skipped', 'reviewing', 'pending_retry'])('legacy overlimit %s record never replays a notification', async status => {
  seed(25, head, status); await polls(3); restart(); await polls(2);
  expect(executeReview).not.toHaveBeenCalled(); expect(postComment).not.toHaveBeenCalled();
  expect(state.getPRRetryCount(info.owner, info.repo, info.prNumber)).toBe(25);
});

test('known changed revision has its own budget, old revision remains exhausted on revert', async () => {
  seed(25); (getPRHeadSha as jest.Mock).mockResolvedValue(next); await polls(5);
  expect(executeReview).toHaveBeenCalledTimes(3); expect(postComment).toHaveBeenCalledTimes(1);
  (getPRHeadSha as jest.Mock).mockResolvedValue(head); restart(); await polls(2);
  expect(executeReview).toHaveBeenCalledTimes(3); expect(postComment).toHaveBeenCalledTimes(1);
});

test.each([null, 'short-sha'])('unknown or malformed current revision %s cannot reopen exhausted work', async revision => {
  seed(25); (getPRHeadSha as jest.Mock).mockResolvedValue(revision); await polls(3);
  expect(executeReview).not.toHaveBeenCalled(); expect(postComment).not.toHaveBeenCalled();
});

test('missing failed revision is not proof of new commits', async () => {
  seed(25, null); (getPRHeadSha as jest.Mock).mockResolvedValue(next); await polls(3);
  expect(executeReview).not.toHaveBeenCalled(); expect(postComment).not.toHaveBeenCalled();
});

test('manual wrapper cannot bypass exhausted legacy state', async () => {
  seed(25); const review = jest.fn().mockRejectedValue(new Error('failed'));
  const result = await executeReviewWithRetry(info, review);
  expect(result.skipped).toBe(true); expect(review).not.toHaveBeenCalled(); expect(postComment).not.toHaveBeenCalled();
});

test.each(['rejection', 'response loss'])('failed notification %s is attempted at most once after state overwrite and restart', async () => {
  (postComment as jest.Mock).mockRejectedValue(new Error('response lost'));
  await polls(3);
  expect(postComment).toHaveBeenCalledTimes(1);
  state.markPRReviewed(info.owner, info.repo, info.prNumber, 'pending_retry');
  state.clearPRRetries(info.owner, info.repo, info.prNumber);
  restart(); await polls(4);
  expect(executeReview).toHaveBeenCalledTimes(3); expect(postComment).toHaveBeenCalledTimes(1);
});

test('state persistence failure before fallback POST fails closed', async () => {
  await polls(2);
  const original = fs.fsyncSync;
  jest.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    // Fail actual file durability, not directory/lock setup.
    if (fs.fstatSync(fd).isFile()) throw new Error('disk unavailable');
    original(fd);
  });
  await polls(1);
  expect(postComment).not.toHaveBeenCalled();
});

test('parallel manual/poll ingress cannot duplicate attempts or failure comments', async () => {
  await polls(2);
  const other = new ReviewedPRsState(file); other.load();
  const review = jest.fn().mockRejectedValue(new Error('failed'));
  const first = executeReviewWithRetry(info, review);
  (getSharedState as jest.Mock).mockReturnValue(other);
  await Promise.all([first, executeReviewWithRetry(info, review), pollAssignedPRs()]);
  expect(review).toHaveBeenCalledTimes(1); expect(postComment).toHaveBeenCalledTimes(1);
});

test('authentication failure alerts operators without a PR fallback', async () => {
  (executeReview as jest.Mock).mockRejectedValue(new Error('refresh token already used; 401 Unauthorized'));
  await polls(5); restart(); await polls(2);
  expect(executeReview).toHaveBeenCalledTimes(3);
  expect(sendReviewFailedNotification).toHaveBeenCalledTimes(1);
  expect(postComment).not.toHaveBeenCalled();
});

test('successful COMMENT/report result keeps awaiting_human_review status', async () => {
  (executeReview as jest.Mock).mockImplementation(async () => {
    state.markPRReviewed(info.owner, info.repo, info.prNumber, 'awaiting_human_review', head);
    return { success: true, verdict: 'awaiting_human_review', commentPosted: true };
  });
  await polls(2); restart();
  expect(executeReview).toHaveBeenCalledTimes(1);
  expect(state.data.reviewedPRs[key].status).toBe('awaiting_human_review');
});

test('legacy exhaustion survives stale-instance status overwrite before the next poll', async () => {
  const stale = new ReviewedPRsState(file); stale.load();
  seed(25);
  stale.markPRReviewed(info.owner, info.repo, info.prNumber, 'pending_retry');
  restart(); await polls(2);
  expect(executeReview).not.toHaveBeenCalled(); expect(postComment).not.toHaveBeenCalled();
});

test.each(['reservation', 'completion'])('failure notification %s fsync failure never permits another POST', async boundary => {
  await polls(2);
  const sync = fs.fsyncSync;
  jest.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    const marker = state.data.reviewRetryBudgets?.[`${key}:${head}`]?.failureNotification;
    if (fs.fstatSync(fd).isFile() && marker === (boundary === 'reservation' ? 'attempted' : 'completed')) {
      throw new Error(`${boundary} sync failed`);
    }
    sync(fd);
  });
  await polls(1); jest.restoreAllMocks();
  expect(postComment).toHaveBeenCalledTimes(boundary === 'reservation' ? 0 : 1);
  restart(); await polls(3);
  expect(postComment).toHaveBeenCalledTimes(boundary === 'reservation' ? 0 : 1);
});

test('durable notification reservation is exclusive across independent state instances', async () => {
  await polls(2);
  const other = new ReviewedPRsState(file); other.load();
  expect(state.beginPRRetryAttempt(info.owner, info.repo, info.prNumber, head)).toBe(true);
  state.recordPRRevisionFailure(info.owner, info.repo, info.prNumber, head, 'failed');
  expect(state.reserveFailureNotification(info.owner, info.repo, info.prNumber, head)).toBe(true);
  expect(other.reserveFailureNotification(info.owner, info.repo, info.prNumber, head)).toBe(false);
  other.markPRReviewed(info.owner, info.repo, info.prNumber, 'reviewed');
  other.pruneOldEntries(0);
  restart();
  expect(state.reserveFailureNotification(info.owner, info.repo, info.prNumber, head)).toBe(false);
});

test('actual Discord message ingress shares the poller retry gate', async () => {
  const previous = [config.discordBotToken, config.discordChannelId];
  config.discordBotToken = 'fixture-only'; config.discordChannelId = 'fixture-channel';
  try {
    startDiscordBot();
    const message = { author: { bot: false }, channelId: 'fixture-channel',
      content: `https://github.com/${info.owner}/${info.repo}/pull/${info.prNumber}`, reply: jest.fn() };
    seed(25);
    await mockHandlers.messageCreate(message);
    expect(executeReview).not.toHaveBeenCalled(); expect(postComment).not.toHaveBeenCalled();
    (getPRHeadSha as jest.Mock).mockResolvedValue(next);
    for (let i = 0; i < 5; i++) await mockHandlers.messageCreate(message);
    expect(executeReview).toHaveBeenCalledTimes(3); expect(postComment).toHaveBeenCalledTimes(1);
    expect(executeReview).toHaveBeenCalledWith(info.owner, info.repo, info.prNumber, undefined, undefined, next);
  } finally { [config.discordBotToken, config.discordChannelId] = previous; }
});

test('a lower stale ledger cannot reopen an overlimit legacy counter', async () => {
  const data = { reviewedPRs: { [key]: { ...info, status: 'skipped', retryCount: 25, reviewingHeadSha: head } }, repliedComments: {},
    reviewRetryBudgets: { [`${key}:${head}`]: { retryCount: 1, blocked: false } } };
  fs.writeFileSync(file, JSON.stringify(data)); restart(); await polls(2);
  expect(executeReview).not.toHaveBeenCalled(); expect(postComment).not.toHaveBeenCalled();
});

test('an old successful attempt cannot release a newer revision lock', () => {
  state.markPRReviewed(info.owner, info.repo, info.prNumber, 'awaiting_human_review', head);
  expect(state.beginPRRetryAttempt(info.owner, info.repo, info.prNumber, next)).toBe(true);
  state.completePRRetryAttempt(info.owner, info.repo, info.prNumber, head);
  expect(state.isPRReviewing(info.owner, info.repo, info.prNumber)).toBe(true);
  expect(state.data.reviewedPRs[key].retryHeadSha).toBe(next);
});

test('manual retry of an already completed COMMENT does not overwrite its status', async () => {
  state.markPRReviewed(info.owner, info.repo, info.prNumber, 'awaiting_human_review', head);
  await executeReviewWithRetry(info, async () => ({ success: true, verdict: 'already_reviewed', commentPosted: false }));
  expect(state.data.reviewedPRs[key].status).toBe('awaiting_human_review');
});

test('old capacity failure cannot release a newer revision lock', () => {
  state.markPRReviewed(info.owner, info.repo, info.prNumber, 'awaiting_human_review', head);
  expect(state.beginPRRetryAttempt(info.owner, info.repo, info.prNumber, next)).toBe(true);
  (state.markPRCapacityRetry as any)(info.owner, info.repo, info.prNumber, 'capacity', head);
  expect(state.isPRReviewing(info.owner, info.repo, info.prNumber)).toBe(true);
});

test('post-success retry cleanup failure never charges a semantic failure or posts fallback', async () => {
  jest.spyOn(state, 'completePRRetryAttempt').mockImplementation(() => { throw new Error('cleanup disk failure'); });
  await executeReviewWithRetry(info, async () => {
    state.markPRReviewed(info.owner, info.repo, info.prNumber, 'awaiting_human_review', head);
    return { success: true, verdict: 'awaiting_human_review', commentPosted: true };
  });
  expect(state.data.reviewRetryBudgets?.[`${key}:${head}`].retryCount).toBe(0);
  expect(state.data.reviewedPRs[key].status).toBe('awaiting_human_review');
  expect(postComment).not.toHaveBeenCalled();
});
