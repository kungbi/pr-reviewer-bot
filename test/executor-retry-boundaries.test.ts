import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'child_process';
import ReviewedPRsState, { getSharedState } from '../src/utils/state-manager';
import { executeReview } from '../src/review/review-executor';
import { executeReviewWithRetry } from '../src/review/polling-reviewer';
import { postComment, postInlineReview, postReviewCommentReply, getPRDetails, listReviewThreads } from '../src/github';
import { sendReviewFailedNotification } from '../src/discord-notifier';
import { ModelCapacityError } from '../src/utils/sessions_spawn';
import { writeReportOutbox, readReportOutbox, ReportRecoveryError, ReportPublicationAmbiguousError } from '../src/review/review-report-outbox';
import config from '../src/utils/config';
import logger from '../src/utils/logger';

jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), spawn: jest.fn() }));
jest.mock('../src/utils/state-manager', () => ({ __esModule: true, ...jest.requireActual('../src/utils/state-manager'), getSharedState: jest.fn() }));
jest.mock('../src/github', () => ({ getPRDetails: jest.fn(), getPRHeadSha: jest.fn(), listReviewThreads: jest.fn(), postComment: jest.fn(), postInlineReview: jest.fn(), postReviewCommentReply: jest.fn() }));
jest.mock('../src/discord-notifier', () => ({ sendReviewStartedNotification: jest.fn(), sendReviewFailedNotification: jest.fn() }));
jest.mock('../src/utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const pr = { owner: 'specup', repo: 'timespread-api-nest', prNumber: 1471, title: 'boundary regression' };
const key = `${pr.owner}/${pr.repo}#${pr.prNumber}`;
let root: string, file: string, state: ReviewedPRsState;
let previousRoot: string | undefined;
let previousAgent: typeof config.reviewAgent;
let previousClone: boolean;
function reload() {
  state = new ReviewedPRsState(file); state.load(); (getSharedState as jest.Mock).mockReturnValue(state);
}
function outbox() {
  writeReportOutbox({ ...pr, headSha: A, details: null, status: 'published',
    draft: { summary: 'saved review', comments: [], replies: [], existingFindings: [] } });
}
const run = () => executeReviewWithRetry({ ...pr, headSha: A }, info =>
  executeReview(info.owner, info.repo, info.prNumber, undefined, undefined, info.headSha ?? undefined));

beforeEach(() => {
  jest.clearAllMocks();
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'executor-retry-boundaries-'));
  previousRoot = process.env.PR_REVIEWER_RUNTIME_ROOT; process.env.PR_REVIEWER_RUNTIME_ROOT = root;
  file = path.join(root, 'state', 'reviewed-prs.json'); reload();
  previousAgent = config.reviewAgent; previousClone = config.prCloneEnabled;
  config.reviewAgent = 'codex'; config.prCloneEnabled = false;
  (getPRDetails as jest.Mock).mockResolvedValue({ title: pr.title, author: { login: 'author' },
    headSha: A, baseSha: 'c'.repeat(40), headRefName: 'feature', baseRefName: 'main' });
  (listReviewThreads as jest.Mock).mockResolvedValue([]);
});
afterEach(() => {
  jest.restoreAllMocks();
  config.reviewAgent = previousAgent; config.prCloneEnabled = previousClone;
  if (previousRoot === undefined) delete process.env.PR_REVIEWER_RUNTIME_ROOT;
  else process.env.PR_REVIEWER_RUNTIME_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

// Only the process boundary is fake: sessions_spawn, gate, executor, wrapper,
// admission and durable retry state all execute their actual production code.
test.each(['stderr', 'long stderr', 'terminal nonzero', 'terminal zero'])('Codex %s auth401 through real gate/executor/wrapper is typed, sanitized and operator-only on third failure', async format => {
  const secret = 'fixture-provider-secret-must-not-escape';
  const raw = `${format === 'long stderr' ? 'x'.repeat(600) : ''}401 Unauthorized refresh_token_already_used Authorization: Bearer ${secret}`;
  (spawn as jest.Mock).mockImplementation(() => {
    const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { write: jest.fn(), end: jest.fn() } });
    queueMicrotask(() => {
      if (format.startsWith('terminal')) proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.failed', error: { code: 'refresh_token_already_used', message: raw } })));
      else proc.stderr.emit('data', Buffer.from(raw));
      proc.emit('close', format === 'terminal zero' ? 0 : 1);
    });
    return proc;
  });
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  // Independently prove type preservation instead of relying on wording alone.
  const typed = await executeReview(pr.owner, pr.repo, pr.prNumber, state, undefined, A).catch(error => error);
  jest.clearAllMocks();
  for (let i = 0; i < 3; i++) {
    const outcome = await run();
    expect(outcome).toMatchObject({ success: false, skipped: i === 2, retryCount: i + 1 });
  }
  reload(); await run(); await run();
  expect(spawn).toHaveBeenCalledTimes(3);
  expect(postComment).not.toHaveBeenCalled();
  expect(typed).toMatchObject({ name: 'ModelAuthenticationError', code: 'provider_authentication_failed' });
  expect(typed.cause).toBeUndefined();
  expect(typed.message.length).toBeLessThan(200);
  expect(postInlineReview).not.toHaveBeenCalled();
  expect(postReviewCommentReply).not.toHaveBeenCalled();
  expect(sendReviewFailedNotification).toHaveBeenCalledTimes(1);
  expect(sendReviewFailedNotification).toHaveBeenCalledWith(expect.objectContaining({ permanentlySkipped: true,
    errorMessage: expect.stringContaining('authentication failed') }));
  const surfaced = JSON.stringify({ state: state.data, alerts: (sendReviewFailedNotification as jest.Mock).mock.calls,
    console: consoleError.mock.calls,
    logs: [logger.info, logger.warn, logger.error].map(log => (log as jest.Mock).mock.calls) });
  expect(surfaced).not.toContain(secret);
  expect(surfaced).not.toContain(raw);
  expect(state.data.reviewRetryBudgets?.[`${key}:${A}`]).toMatchObject({ retryCount: 3, blocked: true, failureNotification: 'completed' });
});

test.each([
  ['report recovery', () => new ReportRecoveryError('render failed')],
  ['publication ambiguous', () => new ReportPublicationAmbiguousError()],
  ['capacity', () => new ModelCapacityError('capacity', 'verifier', 3)],
  ['generic', () => new Error('storage failed')],
  ['authentication', () => new Error('401 Unauthorized refresh_token_already_used')],
] as const)('old A recovery %s failure leaves outstanding B admission untouched and A retry eligible', async (_label, error) => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const outstanding = executeReviewWithRetry({ ...pr, headSha: B }, async () => {
    entered(); await new Promise<void>(resolve => { release = resolve; });
    return { success: true, verdict: 'already_reviewed', commentPosted: false };
  });
  await started;
  try {
    outbox();
    const before = fs.readFileSync(file, 'utf8');
    const recover = jest.fn(async () => { throw error(); });
    for (let i = 0; i < 2; i++) {
      await executeReviewWithRetry({ ...pr, headSha: A }, recover);
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
      reload();
      expect(state.isPRReviewing(pr.owner, pr.repo, pr.prNumber)).toBe(true);
      const duplicate = jest.fn();
      expect(await executeReviewWithRetry({ ...pr, headSha: B }, duplicate)).toMatchObject({ skipped: true });
      expect(duplicate).not.toHaveBeenCalled();
    }
    expect(recover).toHaveBeenCalledTimes(2);
    expect(readReportOutbox(pr.owner, pr.repo, pr.prNumber, A)).not.toBeNull();
    expect(postComment).not.toHaveBeenCalled();
  } finally { release(); await outstanding; }
});

test('actual published-report recovery failure cannot release B while rebuilding A', async () => {
  outbox();
  expect(state.beginPRRetryAttempt(pr.owner, pr.repo, pr.prNumber, B)).toBe(true);
  const before = fs.readFileSync(file, 'utf8');
  for (let i = 0; i < 2; i++) {
    await executeReviewWithRetry({ ...pr, headSha: A }, info => executeReview(info.owner, info.repo, info.prNumber, state, A));
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    reload();
    expect(state.beginPRRetryAttempt(pr.owner, pr.repo, pr.prNumber, B)).toBe(false);
  }
  expect(readReportOutbox(pr.owner, pr.repo, pr.prNumber, A)).not.toBeNull();
  expect(spawn).not.toHaveBeenCalled(); expect(postInlineReview).not.toHaveBeenCalled();
});

test('ordinary capacity releases its own admission without consuming permanent retries', async () => {
  const review = jest.fn(async () => { throw new ModelCapacityError('capacity', 'primary', 3); });
  for (let i = 0; i < 2; i++) {
    expect(await executeReviewWithRetry({ ...pr, headSha: B }, review)).toMatchObject({ retryCount: 0, skipped: false });
    reload(); expect(state.isPRReviewing(pr.owner, pr.repo, pr.prNumber)).toBe(false);
    expect(state.data.reviewedPRs[key]).toMatchObject({ status: 'pending_retry', retryCount: 0, capacityRetryCount: i + 1 });
  }
  expect(review).toHaveBeenCalledTimes(2); expect(postComment).not.toHaveBeenCalled();
});
