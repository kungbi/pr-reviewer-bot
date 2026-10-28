import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

jest.mock('../src/utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

// Loading modules from a release directory must never select release-local data.
describe('runtime state root', () => {
  const cwd = process.cwd();
  const previous = process.env.PR_REVIEWER_RUNTIME_ROOT;
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-state-'));
    process.chdir(root);
    delete process.env.PR_REVIEWER_RUNTIME_ROOT;
    jest.resetModules();
  });
  afterEach(() => {
    process.chdir(cwd);
    if (previous === undefined) delete process.env.PR_REVIEWER_RUNTIME_ROOT;
    else process.env.PR_REVIEWER_RUNTIME_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  it.each([false, true])('preserves the existing canonical state (explicit root: %s)', explicit => {
    const runtime = explicit ? path.join(root, 'persistent') : root;
    if (explicit) process.env.PR_REVIEWER_RUNTIME_ROOT = runtime;
    const directory = path.join(runtime, 'state');
    fs.mkdirSync(directory, { recursive: true });
    const original = JSON.stringify({ reviewedPRs: {}, repliedComments: { '123': { commentedAt: 'old' } }, closedReviewThreads: { old: { resolution: 'human_handoff' } }, reviewPublications: { old: { status: 'completed' } } });
    const file = path.join(directory, 'reviewed-prs.json');
    fs.writeFileSync(file, original);
    const { getSharedState, STATE_FILE } = require('../src/utils/state-manager');
    const { REVIEW_MEMORY_FILE } = require('../src/review-memory/review-memory-store');
    const state = getSharedState();
    expect(STATE_FILE).toBe(file);
    expect(state.isCommentReplied(123)).toBe(true);
    expect(state.getReviewPublication('old')).toMatchObject({ status: 'completed' });
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(REVIEW_MEMORY_FILE).toBe(path.join(directory, 'review-memory.json'));
    expect(require('../src/utils/config').default.repositoryCacheDirectory).toBe(path.join(directory, 'repository-cache'));
    const outbox = require('../src/review/review-report-outbox');
    const entry = { owner: 'acme', repo: 'repo', prNumber: 1, headSha: 'a'.repeat(40), details: null, draft: { summary: 'saved', comments: [], replies: [], existingFindings: [] }, status: 'published' };
    outbox.writeReportOutbox(entry);
    expect(outbox.listReportOutbox()).toEqual([entry]);
    expect(fs.existsSync(path.join(directory, 'review-report-outbox'))).toBe(true);
    const { storeReviewReportHtml } = require('../src/review/review-report-store');
    expect(storeReviewReportHtml({ owner: 'acme', repository: 'repo', pullRequestNumber: 1, headSha: entry.headSha, html: '<p>saved</p>' })).toBe(path.join(directory, 'review-reports', `acme__repo__1__${entry.headSha}.html`));
  });
  it('durably initializes a genuinely missing file on explicit load, before strict reservation', () => {
    const State = require('../src/utils/state-manager').default;
    const file = path.join(root, 'state', 'reviewed-prs.json');
    const state = new State(file);
    state.load();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ reviewedPRs: {}, repliedComments: {} });
    expect(state.reserveReviewPublication('new', { owner: 'acme', repo: 'repo', prNumber: 1, headSha: 'a'.repeat(40), botLogin: 'bot', pendingBody: 'body', pendingEvent: 'COMMENT', pendingComments: [], operationMarker: 'marker' })).toBe(true);
    const restarted = new State(file); restarted.load();
    expect(restarted.getReviewPublication('new')).toMatchObject({ status: 'pending' });
    fs.unlinkSync(file);
    expect(() => restarted.getDurableReviewPublication('new')).toThrow(/missing/i);
  });
  it('refuses to manufacture empty publication history alongside an existing outbox', () => {
    const directory = path.join(root, 'state');
    fs.mkdirSync(path.join(directory, 'review-report-outbox'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'review-report-outbox', `${'a'.repeat(64)}.json`), '{"status":"prepared"}');
    const State = require('../src/utils/state-manager').default;
    expect(() => new State().load()).toThrow(/missing.*outbox/i);
    expect(fs.existsSync(path.join(directory, 'reviewed-prs.json'))).toBe(false);
  });
  it('does not acknowledge initialization when file fsync fails', () => {
    const State = require('../src/utils/state-manager').default;
    const file = path.join(root, 'state', 'reviewed-prs.json');
    const realSync = fs.fsyncSync;
    const sync = jest.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (fs.fstatSync(fd).isFile()) throw new Error('durability failure');
      realSync(fd);
    });
    try { expect(() => new State(file).load()).toThrow('durability failure'); }
    finally { sync.mockRestore(); }
    expect(fs.existsSync(file)).toBe(false);
  });
  it('does not initialize while another process owns the startup lock', () => {
    const State = require('../src/utils/state-manager').default;
    const file = path.join(root, 'state', 'reviewed-prs.json');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(`${file}.review-publication.lock`, 'locked');
    expect(() => new State(file).load()).toThrow(/lock/i);
    expect(fs.existsSync(file)).toBe(false);
  });
  it.each(['', 'relative/runtime'])('rejects an invalid explicit runtime root: %s', value => {
    process.env.PR_REVIEWER_RUNTIME_ROOT = value;
    expect(() => require('../src/utils/state-manager')).toThrow(/absolute directory/);
  });
  it.each(['{bad', '{"unrelated":true}', '{"reviewedPRs":{},"reviewPublications":null}'])('fails startup closed on invalid state: %s', content => {
    fs.mkdirSync(path.join(root, 'state'));
    const file = path.join(root, 'state', 'reviewed-prs.json');
    fs.writeFileSync(file, content);
    const State = require('../src/utils/state-manager').default;
    const state = new State(file);
    expect(() => state.load()).toThrow();
    expect(() => state.markCommentReplied(123)).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe(content);
  });
});
