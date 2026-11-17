'use strict';
// No service startup, credentials, agents, or network: compiled production
// poller/wrapper/state/GitHub client with a failing analysis and fake transport.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const dist = path.resolve(__dirname, '../dist/src');
const stateModule = require(path.join(dist, 'utils/state-manager'));
const State = stateModule.default;
const sha = 'cae2999e7220b9d6380afb14c4fa387752dae733';
const key = 'specup/timespread-api-nest#1471';

if (process.argv[2] === '--reserve') {
  const state = new State(process.argv[3]);
  process.once('message', () => {
    const reserved = state.reserveFailureNotification('specup', 'timespread-api-nest', 1471, sha);
    process.send({ reserved }, () => process.disconnect());
  });
  process.send({ ready: true });
} else {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compiled-failure-spam-'));
  const originalRoot = process.env.PR_REVIEWER_RUNTIME_ROOT;
  process.env.PR_REVIEWER_RUNTIME_ROOT = root;
  let currentSha = sha;
  let reviews = 0;
  let posts = 0;
  let alerts = 0;
  let failure = 'analysis failed';
  const replace = (relative, exports) => {
    const filename = require.resolve(path.join(dist, relative));
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
  };
  replace('review/review-executor', {
    isReviewDraining: () => false,
    executeReview: async (_owner, _repo, _number, _state, _recovery, expected) => {
      assert.equal(expected, currentSha);
      reviews++; throw new Error(failure);
    },
  });
  replace('discord-notifier', { sendReviewFailedNotification: async () => { alerts++; } });
  const axios = require('axios');
  axios.get = async url => ({ headers: {}, data: url.includes('/search/issues')
    ? { items: [{ number: 1471, title: 'compiled smoke', html_url: 'https://github.com/specup/timespread-api-nest/pull/1471' }] }
    : { head: { sha: currentSha } } });
  axios.post = async url => {
    assert.match(url, /\/issues\/1471\/comments$/);
    posts++; throw new Error('response lost after server committed POST');
  };
  const { pollAssignedPRs } = require(path.join(dist, 'poller'));
  const file = path.join(root, 'state', 'reviewed-prs.json');
  const reload = () => { const state = new State(file); state.load(); stateModule.getSharedState = () => state; return state; };
  const poll = async count => { for (let i = 0; i < count; i++) await pollAssignedPRs(); };
  try {
    let state = reload();
    await poll(6); state = reload(); await poll(4);
    assert.equal(reviews, 3); assert.equal(posts, 1); assert.equal(alerts, 1);
    assert.equal(state.data.reviewRetryBudgets[`${key}:${sha}`].failureNotification, 'delivery_unknown');
    // A stale ordinary save cannot erase a durable notification or retry budget.
    state.markPRReviewed('specup', 'timespread-api-nest', 1471, 'pending_retry');
    state = reload(); await poll(2); assert.equal(posts, 1); assert.equal(reviews, 3);
    currentSha = 'b'.repeat(40); failure = 'refresh token already used; 401 Unauthorized';
    await poll(5); state = reload(); await poll(2);
    assert.equal(reviews, 6); assert.equal(posts, 1); assert.equal(alerts, 2);
    currentSha = sha; await poll(2); assert.equal(reviews, 6);
    currentSha = null; await poll(2); assert.equal(reviews, 6);
    // Unmarked exhausted production-era records must not create new comments.
    fs.writeFileSync(file, JSON.stringify({ reviewedPRs: { [key]: {
      owner: 'specup', repo: 'timespread-api-nest', prNumber: 1471,
      status: 'skipped', retryCount: 25, reviewingHeadSha: sha,
    } }, repliedComments: {} }));
    currentSha = sha; state = reload(); await poll(3);
    assert.equal(reviews, 6); assert.equal(posts, 1);
    assert.equal(state.data.reviewRetryBudgets[`${key}:${sha}`].failureNotification, 'suppressed_legacy');
    // Independent real processes race on the established exclusive state lock.
    state.data.reviewRetryBudgets = { [`${key}:${sha}`]: { retryCount: 3, blocked: true } };
    fs.writeFileSync(file, JSON.stringify(state.data));
    const workers = [0, 1].map(() => fork(__filename, ['--reserve', file], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }));
    let readyCount = 0;
    const results = workers.map(worker => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { worker.kill(); reject(new Error('reservation worker timed out')); }, 10000);
      worker.on('error', reject);
      worker.on('message', message => {
        if (message.ready) { if (++readyCount === workers.length) workers.forEach(child => child.send('go')); }
        else { clearTimeout(timeout); resolve(message.reserved); }
      });
      worker.on('exit', code => { if (code) reject(new Error(`reservation worker exited ${code}`)); });
    }));
    assert.equal((await Promise.all(results)).filter(Boolean).length, 1);
    assert.equal(JSON.parse(fs.readFileSync(file)).reviewRetryBudgets[`${key}:${sha}`].failureNotification, 'attempted');
    console.log(JSON.stringify({ compiledSmoke: 'PASS', realPollerWrapperState: true,
      analysisAttempts: reviews, githubTransportAttempts: posts, operatorAlerts: alerts,
      responseLossNoReplay: true, restartNoReplay: true, legacy25NoPost: true,
      authNoPrFallback: true, concurrentProcessReservations: 1 }));
  } finally {
    if (originalRoot === undefined) delete process.env.PR_REVIEWER_RUNTIME_ROOT;
    else process.env.PR_REVIEWER_RUNTIME_ROOT = originalRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
