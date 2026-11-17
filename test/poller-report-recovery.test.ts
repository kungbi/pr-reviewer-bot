import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import ReviewedPRsState from '../src/utils/state-manager';
import { ReportRecoveryError } from '../src/review/review-report-outbox';
import { writeReportOutbox } from '../src/review/review-report-outbox';
import { listReportOutbox } from '../src/review/review-report-outbox';

jest.mock('axios');
jest.mock('../src/utils/state-manager', () => ({
  __esModule: true,
  ...jest.requireActual('../src/utils/state-manager'),
  getSharedState: jest.fn(),
}));
jest.mock('../src/review/review-executor', () => ({ executeReview: jest.fn(), isReviewDraining: jest.fn(() => false) }));
jest.mock('../src/review/review-report-outbox', () => ({
  ...jest.requireActual('../src/review/review-report-outbox'),
  readReportOutbox: jest.fn(() => ({ status: 'published' })),
}));
import { getSharedState } from '../src/utils/state-manager';
import { executeReview } from '../src/review/review-executor';
import { getPRHeadSha } from '../src/github';
import { pollAssignedPRs } from '../src/poller';
jest.mock('../src/github', () => ({ getPRHeadSha: jest.fn(), postComment: jest.fn() }));

test.each(['ambiguous', 'published'])('old %s outbox does not starve the current HEAD', async (status) => {
  jest.clearAllMocks();
  const old = process.cwd();
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'poller-cross-head-'));
  process.chdir(dir);
  try {
    const state = new ReviewedPRsState(path.join(dir, 'state.json'));
    state.load();
    (getSharedState as jest.Mock).mockReturnValue(state);
    (getPRHeadSha as jest.Mock).mockResolvedValue('b'.repeat(40));
    (axios.get as jest.Mock).mockResolvedValue({ data: { items: [{ number: 1, title: 'PR', html_url: 'https://github.com/acme/repo/pull/1' }] } });
    const outbox = jest.requireActual('../src/review/review-report-outbox');
    (require('../src/review/review-report-outbox').readReportOutbox as jest.Mock).mockImplementation(outbox.readReportOutbox);
    writeReportOutbox({ owner: 'acme', repo: 'repo', prNumber: 1, headSha: 'a'.repeat(40), details: null, draft: { summary: '', comments: [], replies: [], existingFindings: [] }, status: status === 'published' ? 'published' : 'prepared' });
    (executeReview as jest.Mock).mockImplementation(async (...args: unknown[]) => {
      if (args[4] && status === 'ambiguous') throw new ReportRecoveryError('ambiguous');
      return { success: true, verdict: 'already_reviewed', commentPosted: false };
    });
    await pollAssignedPRs();
    expect(executeReview).toHaveBeenCalledTimes(2);
    expect(executeReview).toHaveBeenNthCalledWith(1, 'acme', 'repo', 1, state, 'a'.repeat(40));
    expect(executeReview).toHaveBeenNthCalledWith(2, 'acme', 'repo', 1, undefined, undefined, 'b'.repeat(40));
  } finally {
    (require('../src/review/review-report-outbox').readReportOutbox as jest.Mock).mockImplementation(() => ({ status: 'published' }));
    process.chdir(old); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('poisoned current revision is skipped while other PRs and outboxes proceed', async () => {
  jest.clearAllMocks();
  const old = process.cwd();
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'poller-poison-'));
  process.chdir(dir);
  try {
    const state = new ReviewedPRsState(path.join(dir, 'state.json'));
    state.load();
    (getSharedState as jest.Mock).mockReturnValue(state);
    const actual = jest.requireActual('../src/review/review-report-outbox');
    (require('../src/review/review-report-outbox').readReportOutbox as jest.Mock).mockImplementation(actual.readReportOutbox);
    for (const n of [1, 3]) writeReportOutbox({ owner: 'acme', repo: 'repo', prNumber: n, headSha: 'a'.repeat(40), details: null, draft: { summary: '', comments: [], replies: [], existingFindings: [] }, status: 'published' });
    const root = path.join(dir, 'state', 'review-report-outbox');
    const bad = fs.readdirSync(root).filter(n => n.endsWith('.json')).find(n => JSON.parse(fs.readFileSync(path.join(root, n), 'utf8')).prNumber === 1)!;
    fs.writeFileSync(path.join(root, bad), '{');
    (getPRHeadSha as jest.Mock).mockResolvedValue('a'.repeat(40));
    (axios.get as jest.Mock).mockResolvedValue({ data: { items: [1, 2].map(number => ({ number, title: 'PR', html_url: `https://github.com/acme/repo/pull/${number}` })) } });
    (executeReview as jest.Mock).mockResolvedValue({ success: true, verdict: 'already_reviewed', commentPosted: false });
    await pollAssignedPRs();
    expect(executeReview).toHaveBeenCalledWith('acme', 'repo', 3, state, 'a'.repeat(40));
    expect(executeReview).toHaveBeenCalledWith('acme', 'repo', 2, undefined, undefined, 'a'.repeat(40));
    expect((executeReview as jest.Mock).mock.calls.some(call => call[2] === 1)).toBe(false);
  } finally {
    (require('../src/review/review-report-outbox').readReportOutbox as jest.Mock).mockImplementation(() => ({ status: 'published' }));
    process.chdir(old); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test.each(['malformed', 'permissive', 'symlink'])('invalid %s cursor does not starve unrelated PRs after restart', async kind => {
  jest.clearAllMocks();
  const old = process.cwd();
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'poller-cursor-'));
  process.chdir(dir);
  try {
    const state = new ReviewedPRsState(path.join(dir, 'state.json'));
    state.load();
    (getSharedState as jest.Mock).mockReturnValue(state);
    const actual = jest.requireActual('../src/review/review-report-outbox');
    (require('../src/review/review-report-outbox').readReportOutbox as jest.Mock).mockImplementation(actual.readReportOutbox);
    writeReportOutbox({ owner: 'acme', repo: 'repo', prNumber: 1, headSha: 'a'.repeat(40), details: null, draft: { summary: '', comments: [], replies: [], existingFindings: [] }, status: 'published' });
    const cursor = path.join(dir, 'state', 'review-report-outbox', '.discovery-cursor');
    const target = path.join(dir, 'target');
    fs.writeFileSync(target, 'untouched');
    if (kind === 'symlink') fs.symlinkSync(target, cursor);
    else fs.writeFileSync(cursor, kind === 'malformed' ? 'bad' : 'a'.repeat(64) + '.json', { mode: kind === 'permissive' ? 0o644 : 0o600 });
    (getPRHeadSha as jest.Mock).mockResolvedValue('a'.repeat(40));
    (axios.get as jest.Mock).mockResolvedValue({ data: { items: [1, 2].map(number => ({ number, title: 'PR', html_url: `https://github.com/acme/repo/pull/${number}` })) } });
    (executeReview as jest.Mock).mockResolvedValue({ success: true, verdict: 'already_reviewed', commentPosted: false });
    await pollAssignedPRs();
    expect(executeReview).toHaveBeenCalledWith('acme', 'repo', 1, state, 'a'.repeat(40));
    expect(executeReview).toHaveBeenCalledWith('acme', 'repo', 2, undefined, undefined, 'a'.repeat(40));
    expect((executeReview as jest.Mock).mock.calls.filter(call => call[2] === 1)).toHaveLength(1);
    expect(fs.readFileSync(target, 'utf8')).toBe('untouched');
    jest.isolateModules(() => expect(jest.requireActual<typeof import('../src/review/review-report-outbox')>('../src/review/review-report-outbox').listReportOutbox()).toHaveLength(1));
  } finally {
    (require('../src/review/review-report-outbox').readReportOutbox as jest.Mock).mockImplementation(() => ({ status: 'published' }));
    process.chdir(old); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cursor persistence failure is visible and does not prevent scanning', () => {
  const old = process.cwd();
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'outbox-cursor-write-'));
  process.chdir(dir);
  try {
    writeReportOutbox({ owner: 'acme', repo: 'repo', prNumber: 1, headSha: 'a'.repeat(40), details: null, draft: { summary: '', comments: [], replies: [], existingFindings: [] }, status: 'published' });
    fs.mkdirSync(path.join(dir, 'state', 'review-report-outbox', '.discovery-cursor'));
    const errors: string[] = [];
    expect(listReportOutbox(1000, message => errors.push(message))).toHaveLength(1);
    expect(errors.join(' ')).toMatch(/cursor.*operator intervention/);
  } finally { process.chdir(old); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bounded scans eventually visit entries beyond the first page', () => {
  const old = process.cwd();
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'outbox-pages-'));
  process.chdir(dir);
  try {
    for (let n = 1; n <= 4; n++) writeReportOutbox({ owner: 'acme', repo: 'repo', prNumber: n, headSha: 'a'.repeat(40), details: null, draft: { summary: '', comments: [], replies: [], existingFindings: [] }, status: 'published' });
    const seen = new Set<number>();
    for (let i = 0; i < 5; i++) for (const e of listReportOutbox(2)) seen.add(e.prNumber);
    expect(seen.size).toBe(4);
  } finally { process.chdir(old); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bounded scans make progress across a restart before every page', () => {
  const old = process.cwd();
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'outbox-restart-pages-'));
  process.chdir(dir);
  try {
    for (let n = 1; n <= 4; n++) writeReportOutbox({ owner: 'acme', repo: 'repo', prNumber: n, headSha: 'a'.repeat(40), details: null, draft: { summary: '', comments: [], replies: [], existingFindings: [] }, status: 'published' });
    const seen = new Set<number>();
    for (let i = 0; i < 8; i++) {
      jest.isolateModules(() => {
        const outbox = jest.requireActual<typeof import('../src/review/review-report-outbox')>('../src/review/review-report-outbox');
        for (const entry of outbox.listReportOutbox(2)) seen.add(entry.prNumber);
      });
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4]);
  } finally { process.chdir(old); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('discovers durable outbox even after review request disappears', async () => {
  jest.clearAllMocks();
  const old = process.cwd();
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'poller-outbox-'));
  process.chdir(dir);
  try {
    const state = new ReviewedPRsState(path.join(dir, 'state.json'));
    state.load();
    (getSharedState as jest.Mock).mockReturnValue(state);
    (axios.get as jest.Mock).mockResolvedValue({ data: { items: [] } });
    (executeReview as jest.Mock).mockResolvedValue({ success: true, verdict: 'already_reviewed', commentPosted: false });
    writeReportOutbox({ owner: 'acme', repo: 'repo', prNumber: 1, headSha: 'a'.repeat(40), details: null, draft: { summary: '', comments: [], replies: [], existingFindings: [] }, status: 'published' });
    await pollAssignedPRs();
    expect(executeReview).toHaveBeenCalledWith('acme', 'repo', 1, expect.anything(), 'a'.repeat(40));
  } finally { process.chdir(old); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failed report recovery releases reviewing lock and is retried by the next poll', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poller-recovery-'));
  try {
    const state = new ReviewedPRsState(path.join(dir, 'state.json'));
    state.markPRReviewing('acme', 'repo', 1);
    state.markPRCapacityRetry('acme', 'repo', 1, 'prior failure');
    (getSharedState as jest.Mock).mockReturnValue(state);
    (getPRHeadSha as jest.Mock).mockResolvedValue('abc');
    (axios.get as jest.Mock).mockResolvedValue({ data: { items: [{ number: 1, title: 'PR', html_url: 'https://github.com/acme/repo/pull/1' }] } });
    (executeReview as jest.Mock).mockImplementationOnce(async () => {
      state.markPRReviewing('acme', 'repo', 1);
      throw new ReportRecoveryError('disk failure');
    }).mockResolvedValueOnce({ success: true, verdict: 'already_reviewed', commentPosted: false });
    await pollAssignedPRs();
    expect(state.isPRReviewing('acme', 'repo', 1)).toBe(false);
    expect(state.getPRRetryCount('acme', 'repo', 1)).toBe(0);
    await pollAssignedPRs();
    expect(executeReview).toHaveBeenCalledTimes(2);
    expect(state.isPRReviewing('acme', 'repo', 1)).toBe(false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('recovers an outbox after restart despite a persisted reviewing lock without overlapping live recovery', async () => {
  jest.clearAllMocks();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poller-restart-'));
  try {
    const state = new ReviewedPRsState(path.join(dir, 'state.json'));
    state.markPRReviewing('acme', 'repo', 1);
    (getSharedState as jest.Mock).mockReturnValue(state);
    (getPRHeadSha as jest.Mock).mockResolvedValue('abc');
    (axios.get as jest.Mock).mockResolvedValue({ data: { items: [{ number: 1, title: 'PR', html_url: 'https://github.com/acme/repo/pull/1' }] } });
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    (executeReview as jest.Mock).mockImplementation(async () => { await pending; return { success: true, verdict: 'already_reviewed', commentPosted: false }; });
    const first = pollAssignedPRs();
    for (let i = 0; i < 20 && !(executeReview as jest.Mock).mock.calls.length; i++) await new Promise(resolve => setImmediate(resolve));
    expect(executeReview).toHaveBeenCalledTimes(1);
    await pollAssignedPRs();
    expect(executeReview).toHaveBeenCalledTimes(1);
    finish();
    await first;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('crash after discovery revisits unprocessed entries after cursor wrap, even with deletion', () => {
  const old = process.cwd();
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'outbox-crash-'));
  process.chdir(dir);
  try {
    for (let n = 1; n <= 4; n++) writeReportOutbox({ owner: 'acme', repo: 'repo', prNumber: n, headSha: 'a'.repeat(40), details: null, draft: { summary: '', comments: [], replies: [], existingFindings: [] }, status: 'published' });
    const lost = listReportOutbox(2); // crash before either returned entry is processed
    const remaining = listReportOutbox(2);
    const outbox = jest.requireActual<typeof import('../src/review/review-report-outbox')>('../src/review/review-report-outbox');
    outbox.deleteReportOutbox(remaining[0]);
    const recovered = new Set<number>();
    for (let i = 0; i < 4; i++) jest.isolateModules(() => {
      const fresh = jest.requireActual<typeof import('../src/review/review-report-outbox')>('../src/review/review-report-outbox');
      fresh.listReportOutbox(2).forEach(entry => recovered.add(entry.prNumber));
    });
    for (const entry of lost) expect(recovered.has(entry.prNumber)).toBe(true);
  } finally { process.chdir(old); fs.rmSync(dir, { recursive: true, force: true }); }
});

test.each(['malformed', 'symlink'])('unsafe %s outbox is reported while valid entries remain discoverable', kind => {
  const old = process.cwd();
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'outbox-invalid-'));
  process.chdir(dir);
  try {
    writeReportOutbox({ owner: 'acme', repo: 'repo', prNumber: 1, headSha: 'a'.repeat(40), details: null, draft: { summary: '', comments: [], replies: [], existingFindings: [] }, status: 'published' });
    const root = path.join(dir, 'state', 'review-report-outbox');
    const file = path.join(root, fs.readdirSync(root).find(n => n.endsWith('.json'))!);
    if (kind === 'malformed') fs.writeFileSync(file, '{');
    else { fs.unlinkSync(file); fs.symlinkSync(path.join(dir, 'missing'), file); }
    writeReportOutbox({ owner: 'acme', repo: 'repo', prNumber: 2, headSha: 'b'.repeat(40), details: null, draft: { summary: '', comments: [], replies: [], existingFindings: [] }, status: 'published' });
    const errors: string[] = [];
    expect((listReportOutbox as any)(1000, (error: string) => errors.push(error)).map((e: {prNumber: number}) => e.prNumber)).toEqual([2]);
    expect(errors).toEqual([expect.stringMatching(/outbox discovery failed.*operator intervention/)]);
  } finally { process.chdir(old); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('discovery overflow fails closed with actionable error', () => {
  const old = process.cwd();
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'outbox-overflow-'));
  process.chdir(dir);
  try {
    listReportOutbox();
    const root = path.join(dir, 'state', 'review-report-outbox');
    for (let i = 0; i < 10001; i++) fs.writeFileSync(path.join(root, `extra-${i}`), '');
    expect(() => listReportOutbox()).toThrow(/outbox discovery overflow.*operator intervention/);
  } finally { process.chdir(old); fs.rmSync(dir, { recursive: true, force: true }); }
});
