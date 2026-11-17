'use strict';
// Compiled real sessions -> gate -> executor -> wrapper/state/poller. Only
// subprocess/network/notification boundaries are faked; no service is started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const dist = path.resolve(__dirname, '../dist/src');
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'compiled-executor-boundaries-'));
const previousRoot = process.env.PR_REVIEWER_RUNTIME_ROOT;
process.env.PR_REVIEWER_RUNTIME_ROOT = root;
const A = 'a'.repeat(40), B = 'b'.repeat(40);
const pr = { owner: 'specup', repo: 'timespread-api-nest', prNumber: 1471, title: 'compiled boundary smoke' };
const key = `${pr.owner}/${pr.repo}#${pr.prNumber}`;
const file = path.join(root, 'state', 'reviewed-prs.json');
let processes = 0, writes = 0;
const alerts = [], logs = [];
const replace = (relative, exports) => {
  const filename = require.resolve(path.join(dist, relative));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
const write = async () => { writes++; throw new Error('Unexpected GitHub write'); };
replace('utils/logger', { __esModule: true, default: Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, message => logs.push(message)])) });
replace('github', {
  getPRDetails: async () => ({ title: pr.title, author: { login: 'author' }, headSha: A, baseSha: 'c'.repeat(40), headRefName: 'feature', baseRefName: 'main' }),
  getPRHeadSha: async () => A, listReviewThreads: async () => [],
  postComment: write, postInlineReview: write, postReviewCommentReply: write,
});
replace('discord-notifier', { sendReviewStartedNotification: async () => {}, sendReviewFailedNotification: async event => { alerts.push(event); return true; } });
const childProcess = require('node:child_process');
const originalSpawn = childProcess.spawn;
let format = 'stderr';
const secret = 'fixture-provider-secret-must-not-escape';
const raw = `401 Unauthorized refresh_token_already_used Authorization: Bearer ${secret}`;
childProcess.spawn = () => {
  processes++;
  const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { write() {}, end() {} } });
  queueMicrotask(() => {
    if (format.startsWith('terminal')) proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.failed', error: { code: 'refresh_token_already_used', message: raw } })));
    else proc.stderr.emit('data', Buffer.from((format === 'long stderr' ? 'x'.repeat(600) : '') + raw));
    proc.emit('close', format === 'terminal zero' ? 0 : 1);
  });
  return proc;
};
const stateModule = require(path.join(dist, 'utils/state-manager'));
const State = stateModule.default;
let state;
const reload = () => { state = new State(file); state.load(); stateModule.getSharedState = () => state; };
const config = require(path.join(dist, 'utils/config')).default;
config.reviewAgent = 'codex'; config.prCloneEnabled = false; config.reviewMemoryEnabled = false;
const { executeReview } = require(path.join(dist, 'review/review-executor'));
const { executeReviewWithRetry } = require(path.join(dist, 'review/polling-reviewer'));
const outbox = require(path.join(dist, 'review/review-report-outbox'));
const { ModelCapacityError } = require(path.join(dist, 'utils/sessions_spawn'));
const { ModelAuthenticationError } = require(path.join(dist, 'utils/model-authentication-error'));
const axios = require('axios');
const originalGet = axios.get;
axios.get = async () => ({ data: { items: [{ number: pr.prNumber, title: pr.title, html_url: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.prNumber}` }] } });
const { pollAssignedPRs } = require(path.join(dist, 'poller'));
const run = (sha, fn) => executeReviewWithRetry({ ...pr, headSha: sha }, fn);
const putOutbox = () => outbox.writeReportOutbox({ ...pr, headSha: A, details: null, status: 'published', draft: { summary: 'saved', comments: [], replies: [], existingFindings: [] } });

async function main() {
  const authFormats = ['stderr', 'long stderr', 'terminal nonzero', 'terminal zero'];
  for (format of authFormats) {
    fs.rmSync(path.dirname(file), { recursive: true, force: true }); reload();
    const before = processes, alertsBefore = alerts.length;
    for (let i = 0; i < 5; i++) await pollAssignedPRs();
    reload(); await pollAssignedPRs();
    assert.equal(processes - before, 3);
    assert.equal(alerts.length - alertsBefore, 1);
    assert.equal(alerts.at(-1).permanentlySkipped, true);
    assert.equal(state.data.reviewRetryBudgets[`${key}:${A}`].failureNotification, 'completed');
    await assert.rejects(executeReview(pr.owner, pr.repo, pr.prNumber, state, undefined, A), error => {
      assert(error instanceof ModelAuthenticationError);
      assert.equal(error.code, 'provider_authentication_failed');
      assert.equal(error.cause, undefined);
      assert(error.message.length < 200);
      return true;
    });
  }
  const failures = [
    () => new outbox.ReportRecoveryError('render failed'),
    () => new outbox.ReportPublicationAmbiguousError(),
    () => new ModelCapacityError('capacity', 'verifier', 3),
    () => new Error('storage failed'),
    () => new Error(raw),
  ];
  for (const fail of failures) {
    fs.rmSync(path.dirname(file), { recursive: true, force: true }); reload();
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const outstanding = run(B, async () => {
      entered(); await new Promise(resolve => { release = resolve; });
      return { success: true, verdict: 'already_reviewed', commentPosted: false };
    });
    await started;
    try {
      putOutbox();
      let recoveries = 0;
      for (let i = 0; i < 2; i++) {
        const before = fs.readFileSync(file, 'utf8');
        await run(A, async () => { recoveries++; throw fail(); });
        assert.equal(fs.readFileSync(file, 'utf8'), before);
        reload(); assert.equal(state.isPRReviewing(pr.owner, pr.repo, pr.prNumber), true);
        const duplicate = await run(B, async () => { throw new Error('Duplicate B admitted'); });
        assert.equal(duplicate.skipped, true);
        assert(outbox.readReportOutbox(pr.owner, pr.repo, pr.prNumber, A));
      }
      assert.equal(recoveries, 2);
    } finally { release(); await outstanding; }
  }
  fs.rmSync(path.dirname(file), { recursive: true, force: true }); reload(); putOutbox();
  assert.equal(state.beginPRRetryAttempt(pr.owner, pr.repo, pr.prNumber, B), true);
  for (let i = 0; i < 2; i++) {
    const before = fs.readFileSync(file, 'utf8');
    const result = await run(A, () => executeReview(pr.owner, pr.repo, pr.prNumber, state, A));
    assert.equal(result.success, false);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    reload(); assert.equal(state.beginPRRetryAttempt(pr.owner, pr.repo, pr.prNumber, B), false);
  }
  fs.rmSync(path.dirname(file), { recursive: true, force: true }); reload();
  for (let i = 0; i < 2; i++) {
    const result = await run(B, async () => { throw new ModelCapacityError('capacity', 'primary', 3); });
    assert.equal(result.retryCount, 0); reload();
    assert.equal(state.isPRReviewing(pr.owner, pr.repo, pr.prNumber), false);
    assert.equal(state.data.reviewedPRs[key].capacityRetryCount, i + 1);
  }
  assert.equal(writes, 0);
  assert(!JSON.stringify({ alerts, logs, state: state.data }).includes(secret));
  console.log(JSON.stringify({ compiledExecutorBoundaries: 'PASS', realPollerGateExecutorWrapperState: true,
    authenticationFormats: authFormats.length, thirdFailureOperatorOnly: true, sanitizedTypedAuthentication: true,
    recoveryFailureClasses: failures.length, outstandingBPreserved: true, duplicateBAdmissions: 0,
    realPublishedReportRecoveryRetryEligible: true, normalCapacityRetryEligible: true, githubWrites: writes }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  childProcess.spawn = originalSpawn; axios.get = originalGet;
  if (previousRoot === undefined) delete process.env.PR_REVIEWER_RUNTIME_ROOT;
  else process.env.PR_REVIEWER_RUNTIME_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});
