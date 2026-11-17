import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeReportOutbox, readReportOutbox } from '../src/review/review-report-outbox';
import * as reportOutbox from '../src/review/review-report-outbox';
import { prepareReviewForPosting } from '../src/review/review-draft';
import * as reportStore from '../src/review/review-report-store';
import * as reportRenderer from '../src/review/review-report-renderer';

jest.mock('../src/github', () => ({
  getPRDetails: jest.fn(),
  getPRHeadSha: jest.fn(),
  getPRDiff: jest.fn(),
  listReviewThreads: jest.fn(),
  postInlineReview: jest.fn(),
  postReviewCommentReply: jest.fn(),
  verifyReviewPosted: jest.fn(),
  reconcileAttemptedReviewPublication: jest.fn(),
}));
jest.mock('../src/review/review-verification-gate', () => ({ runReviewVerificationGate: jest.fn() }));
jest.mock('../src/review-memory/review-memory-service', () => ({ getReviewMemoryContext: jest.fn() }));
jest.mock('../src/utils/agent-command', () => ({
  ...jest.requireActual('../src/utils/agent-command'),
  shouldUseLocalClone: jest.fn(() => true),
}));
jest.mock('../src/review/repo-cloner', () => ({ cloneRepoForPR: jest.fn(), cleanupClone: jest.fn() }));
jest.mock('../src/review/repository-cache', () => ({ getSharedRepositoryCache: jest.fn() }));
jest.mock('../src/review/review-test-runner', () => ({ runReviewTestRunner: jest.fn() }));
jest.mock('../src/discord-notifier', () => ({
  sendReviewStartedNotification: jest.fn(),
  sendReviewFailedNotification: jest.fn(),
  sendReviewCompletedNotification: jest.fn(),
}));

import { executeReview } from '../src/review/review-executor';
import {
  getPRDetails,
  getPRDiff,
  getPRHeadSha,
  listReviewThreads,
  postInlineReview,
  postReviewCommentReply,
  verifyReviewPosted,
} from '../src/github';
import { runReviewVerificationGate } from '../src/review/review-verification-gate';
import { getReviewMemoryContext } from '../src/review-memory/review-memory-service';
import { cloneRepoForPR, cleanupClone } from '../src/review/repo-cloner';
import { runReviewTestRunner } from '../src/review/review-test-runner';
import {
  sendReviewCompletedNotification,
  sendReviewFailedNotification,
} from '../src/discord-notifier';
import config from '../src/utils/config';
import ReviewedPRsState from '../src/utils/state-manager';
import { ReviewDraft } from '../src/review/review-draft';

const mockGetPRDetails = getPRDetails as jest.Mock;
const mockGetPRDiff = getPRDiff as jest.Mock;
const mockGetPRHeadSha = getPRHeadSha as jest.Mock;
const mockListReviewThreads = listReviewThreads as jest.Mock;
const mockPostInlineReview = postInlineReview as jest.Mock;
const mockVerifyReviewPosted = verifyReviewPosted as jest.Mock;
const mockRunReviewVerificationGate = runReviewVerificationGate as jest.Mock;
const mockGetReviewMemoryContext = getReviewMemoryContext as jest.Mock;
const mockCloneRepoForPR = cloneRepoForPR as jest.Mock;
const mockCleanupClone = cleanupClone as jest.Mock;
const mockRunReviewTestRunner = runReviewTestRunner as jest.Mock;
const mockSendReviewCompleted = sendReviewCompletedNotification as jest.Mock;
const mockSendReviewFailed = sendReviewFailedNotification as jest.Mock;

const DIFF = [
  'diff --git a/src/service.ts b/src/service.ts',
  'index 0123456..abcdef0 100644',
  '--- a/src/service.ts',
  '+++ b/src/service.ts',
  '@@ -10,1 +10,1 @@',
  '-const value = "before";',
  '+const value = "<script>alert(1)</script>";',
].join('\n');

function localGit(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  }).trim();
}

function verifiedDraft(): ReviewDraft {
  return {
    summary: 'Verified human review summary.',
    comments: [],
    replies: [],
    existingFindings: [],
  };
}

function makeDetails(headSha: string, baseSha: string | undefined = 'a'.repeat(40)) {
  return {
    number: 123,
    title: 'Integration report & escaping',
    body: null,
    state: 'open',
    author: { login: 'author' },
    url: 'https://github.com/acme/payments/pull/123',
    headRefName: 'feature/report',
    baseRefName: 'main',
    headSha,
    baseSha,
    createdAt: '',
    updatedAt: '',
    labels: [],
    milestone: null,
    reviewRequests: [],
    reviews: [],
  };
}

describe('executeReview local HTML report integration', () => {
  let originalCwd: string;
  let testRoot: string;
  let checkoutPath: string;
  let pinnedHeadSha: string;
  let originalCloneEnabled: boolean;
  let originalCacheEnabled: boolean;

  const makeState = () => ({
    isPRReviewed: jest.fn().mockReturnValue(false),
    isPRCompleted: jest.fn().mockReturnValue(false),
    getReviewedHeadSha: jest.fn().mockReturnValue(null),
    markPRReviewed: jest.fn(),
  }) as unknown as ReviewedPRsState;

  const reportDirectory = () => path.join(testRoot, 'state', 'review-reports');

  it('does not charge or review a different head than the retry wrapper pinned', async () => {
    await expect((executeReview as any)('acme', 'payments', 123, makeState(), undefined, 'b'.repeat(40)))
      .rejects.toThrow('revision changed');
    expect(mockRunReviewVerificationGate).not.toHaveBeenCalled();
    expect(mockPostInlineReview).not.toHaveBeenCalled();
  });

  it('releases only the crashed old revision lock after published recovery', async () => {
    const state = new ReviewedPRsState(path.join(testRoot, 'review-state.json'));
    (state.markPRReviewing as any)('acme', 'payments', 123, pinnedHeadSha);
    writeReportOutbox({ owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, details: makeDetails(pinnedHeadSha), draft: verifiedDraft(), status: 'published', diff: DIFF } as any);
    mockGetPRDetails.mockResolvedValue(makeDetails('b'.repeat(40)));
    await executeReview('acme', 'payments', 123, state, pinnedHeadSha);
    expect(state.isPRReviewing('acme', 'payments', 123)).toBe(false);
    expect(mockPostInlineReview).not.toHaveBeenCalled();
  });

  it('preserves a newer revision lock while recovering an older outbox', async () => {
    const file = path.join(testRoot, 'review-state.json');
    const stale = new ReviewedPRsState(file);
    stale.markPRReviewing('acme', 'payments', 123, pinnedHeadSha);
    const newer = new ReviewedPRsState(file); newer.load();
    newer.markPRReviewing('acme', 'payments', 123, 'b'.repeat(40));
    writeReportOutbox({ owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, details: makeDetails(pinnedHeadSha), draft: verifiedDraft(), status: 'published', diff: DIFF } as any);
    mockGetPRDetails.mockResolvedValue(makeDetails('b'.repeat(40)));
    await executeReview('acme', 'payments', 123, stale, pinnedHeadSha);
    const reread = new ReviewedPRsState(file); reread.load();
    expect(reread.isPRReviewing('acme', 'payments', 123)).toBe(true);
    expect(reread.data.reviewedPRs['acme/payments#123'].reviewingHeadSha).toBe('b'.repeat(40));
    expect(mockPostInlineReview).not.toHaveBeenCalled();
  });

  it('does not regress completed newer state when recovering an older published report', async () => {
    const state = new ReviewedPRsState(path.join(testRoot, 'review-state.json'));
    const newer = 'b'.repeat(40);
    state.markPRReviewed('acme', 'payments', 123, 'awaiting_human_review', newer);
    writeReportOutbox({ owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, details: makeDetails(pinnedHeadSha), draft: verifiedDraft(), status: 'published', diff: DIFF } as any);
    mockGetPRDetails.mockResolvedValue(makeDetails(newer));
    await executeReview('acme', 'payments', 123, state, pinnedHeadSha);
    expect(state.getReviewedHeadSha('acme', 'payments', 123)).toBe(newer);
    expect(readReportOutbox('acme', 'payments', 123, pinnedHeadSha)).toBeNull();
    expect(mockPostInlineReview).not.toHaveBeenCalled();
  });

  it('recovers a published pinned diff after both PR revisions change without writes', async () => {
    const state = new ReviewedPRsState(path.join(testRoot, 'review-state.json'));
    writeReportOutbox({ owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, details: makeDetails(pinnedHeadSha), draft: verifiedDraft(), status: 'published', diff: DIFF } as any);
    mockGetPRDetails.mockResolvedValue(makeDetails('b'.repeat(40), 'c'.repeat(40)));
    mockGetPRDiff.mockRejectedValue(new Error('current diff must not be read'));
    await executeReview('acme', 'payments', 123, state, pinnedHeadSha);
    expect(fs.readFileSync(path.join(reportDirectory(), `acme__payments__123__${pinnedHeadSha}.html`), 'utf8')).toContain('Verified human review summary.');
    expect(mockGetPRDiff).not.toHaveBeenCalled();
    expect(mockPostInlineReview).not.toHaveBeenCalled();
    expect(postReviewCommentReply).not.toHaveBeenCalled();
  });

  it.each(['head', 'base', 'failure'])('refuses publication if %s changes during drafting', async (change) => {
    mockGetPRDetails.mockResolvedValueOnce(makeDetails(pinnedHeadSha));
    if (change === 'failure') mockGetPRDetails.mockRejectedValueOnce(new Error('unavailable'));
    else mockGetPRDetails.mockResolvedValueOnce(makeDetails(change === 'head' ? 'b'.repeat(40) : pinnedHeadSha, change === 'base' ? 'c'.repeat(40) : 'a'.repeat(40)));
    await expect(executeReview('acme', 'payments', 123, makeState())).rejects.toThrow();
    expect(mockPostInlineReview).not.toHaveBeenCalled();
    expect(readReportOutbox('acme', 'payments', 123, pinnedHeadSha)).toBeNull();
  });

  beforeEach(() => {
    originalCwd = process.cwd();
    testRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'review-report-integration-'));
    process.chdir(testRoot);
    checkoutPath = path.join(testRoot, 'checkout');
    fs.mkdirSync(checkoutPath, { recursive: true });
    localGit(['init', '-q'], checkoutPath);
    fs.writeFileSync(path.join(checkoutPath, 'tracked.txt'), 'checkout fixture\n');
    localGit(['add', 'tracked.txt'], checkoutPath);
    localGit(['-c', 'user.name=Review Fixture', '-c', 'user.email=review@example.invalid', 'commit', '-q', '--no-gpg-sign', '-m', 'fixture'], checkoutPath);
    pinnedHeadSha = localGit(['rev-parse', 'HEAD'], checkoutPath);

    originalCloneEnabled = config.prCloneEnabled;
    originalCacheEnabled = config.repositoryCacheEnabled;
    config.prCloneEnabled = true;
    config.repositoryCacheEnabled = false;

    jest.clearAllMocks();
    mockGetPRDetails.mockResolvedValue(makeDetails(pinnedHeadSha));
    mockGetPRHeadSha.mockResolvedValue(pinnedHeadSha);
    mockGetPRDiff.mockResolvedValue(DIFF);
    mockListReviewThreads.mockResolvedValue([]);
    mockVerifyReviewPosted.mockResolvedValue(true);
    mockGetReviewMemoryContext.mockReturnValue({ lessons: [] });
    mockCloneRepoForPR.mockResolvedValue({ ok: true, path: checkoutPath, headSha: pinnedHeadSha });
    mockCleanupClone.mockResolvedValue(undefined);
    mockRunReviewTestRunner.mockResolvedValue({
      status: 'passed',
      reason: 'Isolated npm test completed successfully.',
      nodeVersion: '20.11.1',
      testCommand: 'npm test',
      install: { status: 'passed', reason: 'npm ci completed successfully.' },
      test: { status: 'passed', reason: 'npm test exited with code 0.', output: 'tests passed' },
    });
    mockRunReviewVerificationGate.mockImplementation(async (args: { publish: (draft: ReviewDraft) => Promise<void> }) => {
      const draft = verifiedDraft();
      await args.publish(draft);
      return draft;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.chdir(originalCwd);
    config.prCloneEnabled = originalCloneEnabled;
    config.repositoryCacheEnabled = originalCacheEnabled;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it.each([
    ['passed', '격리 테스트 통과'],
    ['failed', '격리 테스트 실패'],
    ['blocked', '격리 테스트 미완료'],
  ] as const)('publishes %s from the authoritative runner and keeps audit evidence private', async (status, label) => {
    const audit = '원본 comments/replies 후보 0건; GitHub GET; 활성 thread 없음; node_modules 없음; 파일/GitHub 변경 없음';
    const draft: ReviewDraft = { ...verifiedDraft(), summary: audit, publicSummary: {
      conclusion: '입력 검증 계약에 새 결함은 확인되지 않았습니다.',
      evidence: ['빈 ID는 validateId에서 거부됩니다.'],
      verificationLimits: ['연관 저장소는 다른 브랜치여서 배포 시 호환성은 미확인입니다.'],
    }, testExecutionStatus: 'passed' };
    mockRunReviewVerificationGate.mockImplementation(async (args) => { await args.publish(draft); return draft; });
    mockRunReviewTestRunner.mockResolvedValue({ status, reason: `runner ${status}`, install: { status: 'passed' }, test: { status, output: 'private diagnostic' } });
    const state = new ReviewedPRsState(path.join(testRoot, 'public-summary-state.json'));
    jest.spyOn(reportStore, 'storeReviewReportHtml').mockImplementationOnce(() => { throw new Error('storage interrupted'); });
    await executeReview('acme', 'payments', 123, state);
    const pending = readReportOutbox('acme', 'payments', 123, pinnedHeadSha);
    expect(pending?.draft).toMatchObject({ publicSummary: draft.publicSummary, testExecutionStatus: status });
    await executeReview('acme', 'payments', 123, state, pinnedHeadSha);
    const body = mockPostInlineReview.mock.calls[0][4];
    expect(body).toContain(label);
    expect(body).toContain('연관 저장소는 다른 브랜치');
    expect(body).not.toContain(audit);
    expect(body).not.toContain('node_modules');
    if (status !== 'passed') expect(body).not.toContain('격리 테스트 통과');
    expect(mockRunReviewTestRunner).toHaveBeenCalledTimes(1);
    expect(mockPostInlineReview).toHaveBeenCalledTimes(1);
    const html = fs.readFileSync(path.join(reportDirectory(), `acme__payments__123__${pinnedHeadSha}.html`), 'utf8');
    expect(html).toContain(audit);
    expect(html).toContain('private diagnostic');
    expect(html).toContain(pinnedHeadSha);
  });

  it.each(['failed', 'blocked', 'passed'] as const)('preserves exact %s test evidence across published report recovery', async (status) => {
    const statePath = path.join(testRoot, 'review-state.json');
    const state = new ReviewedPRsState(statePath);
    mockRunReviewTestRunner.mockResolvedValue({
      status, reason: `overall ${status} evidence`, nodeVersion: '20.11.1', testCommand: 'npm test',
      install: { status: 'passed', reason: 'install succeeded' },
      test: { status, reason: `test stage ${status} evidence`, output: 'bounded diagnostic' },
    });
    const render = jest.spyOn(reportRenderer, 'renderReviewReportHtml');
    jest.spyOn(reportStore, 'storeReviewReportHtml').mockImplementationOnce(() => { throw new Error('crash before report storage'); });
    await executeReview('acme', 'payments', 123, state);
    const original = render.mock.results[0].value;
    expect(readReportOutbox('acme', 'payments', 123, pinnedHeadSha)?.status).toBe('published');
    const restarted = new ReviewedPRsState(statePath); restarted.load();
    await executeReview('acme', 'payments', 123, restarted, pinnedHeadSha);
    const recovered = fs.readFileSync(path.join(reportDirectory(), `acme__payments__123__${pinnedHeadSha}.html`), 'utf8');
    expect(recovered).toBe(original);
    expect(mockRunReviewTestRunner).toHaveBeenCalledTimes(1);
    expect(mockPostInlineReview).toHaveBeenCalledTimes(1);
    expect(postReviewCommentReply).not.toHaveBeenCalled();
  });

  it('rejects a corrupted persisted report without writing or rerunning tests', async () => {
    const statePath = path.join(testRoot, 'review-state.json');
    const state = new ReviewedPRsState(statePath);
    jest.spyOn(reportStore, 'storeReviewReportHtml').mockImplementationOnce(() => { throw new Error('storage failed'); });
    await executeReview('acme', 'payments', 123, state);
    const root = path.join(testRoot, 'state', 'review-report-outbox');
    const file = path.join(root, fs.readdirSync(root).find(name => name.endsWith('.json'))!);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.reportSnapshot.report.testRunner.test.reason = 'tampered evidence';
    fs.writeFileSync(file, JSON.stringify(raw));
    const restarted = new ReviewedPRsState(statePath); restarted.load();
    await expect(executeReview('acme', 'payments', 123, restarted, pinnedHeadSha)).rejects.toThrow();
    expect(fs.existsSync(file)).toBe(true);
    expect(mockRunReviewTestRunner).toHaveBeenCalledTimes(1);
    expect(mockPostInlineReview).toHaveBeenCalledTimes(1);
    expect(postReviewCommentReply).not.toHaveBeenCalled();
  });

  it('runs tests only on a pinned local checkout and persists an escaped, private report at the same SHA', async () => {
    const state = makeState();

    const mapping = { '20.11.1': `sha256:${'a'.repeat(64)}` };
    const old = (config as any).trustedNodeImages;
    (config as any).trustedNodeImages = mapping;
    let result;
    try { result = await executeReview('acme', 'payments', 123, state); }
    finally { (config as any).trustedNodeImages = old; }

    expect(result).toMatchObject({ success: true, verdict: 'awaiting_human_review', commentPosted: true });
    expect(mockRunReviewTestRunner).toHaveBeenCalledWith(checkoutPath, { trustedNodeImages: mapping });
    expect(mockPostInlineReview).toHaveBeenCalledWith(
      'acme', 'payments', 123, pinnedHeadSha, expect.any(String), 'COMMENT', [], state, 'author',
    );
    expect(mockGetPRDiff).toHaveBeenCalledWith('acme', 'payments', 123);
    expect(mockSendReviewFailed).not.toHaveBeenCalled();
    expect(mockSendReviewCompleted).toHaveBeenCalledWith(expect.objectContaining({ localReportStatus: 'generated' }));
    expect(mockSendReviewCompleted.mock.calls[0][0]).not.toHaveProperty('localReportPath');
    expect(mockSendReviewCompleted.mock.calls[0][0]).not.toHaveProperty('reportUrl');

    const files = fs.readdirSync(reportDirectory());
    expect(files).toEqual([`acme__payments__123__${pinnedHeadSha}.html`]);
    const reportPath = path.join(reportDirectory(), files[0]);
    const html = fs.readFileSync(reportPath, 'utf8');
    expect(html).toContain(pinnedHeadSha);
    expect(html).toContain('a'.repeat(40));
    expect(html).toContain('Integration report &amp; escaping');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('통과');
    expect(html).toContain('변경 전');
    expect(html).toContain('변경 후');
    expect((fs.statSync(reportPath).mode & 0o777).toString(8)).toBe('600');
    expect((fs.statSync(path.join(testRoot, 'state')).mode & 0o777).toString(8)).toBe('700');
    expect((fs.statSync(reportDirectory()).mode & 0o777).toString(8)).toBe('700');
  });

  it('propagates configured trust through the executor into real runner stages', async () => {
    const image = `sha256:${'a'.repeat(64)}`;
    const mapping = { '20.11.1': image };
    const old = config.trustedNodeImages;
    fs.writeFileSync(path.join(checkoutPath, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node -e "console.log(12345)"' } }));
    fs.writeFileSync(path.join(checkoutPath, 'package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: { '': { name: 'fixture', version: '1.0.0' } } }));
    fs.writeFileSync(path.join(checkoutPath, '.nvmrc'), '20.11.1\n');
    localGit(['add', 'package.json', 'package-lock.json', '.nvmrc'], checkoutPath);
    localGit(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--no-gpg-sign', '-m', 'runner fixture'], checkoutPath);
    pinnedHeadSha = localGit(['rev-parse', 'HEAD'], checkoutPath);
    mockGetPRDetails.mockResolvedValue(makeDetails(pinnedHeadSha));
    mockCloneRepoForPR.mockResolvedValue({ ok: true, path: checkoutPath, headSha: pinnedHeadSha });
    config.trustedNodeImages = mapping;
    const calls: string[][] = [];
    mockRunReviewTestRunner.mockImplementation((source, options) => jest.requireActual('../src/review/review-test-runner').runReviewTestRunner(source, {
      ...options, scratchRoot: path.join(testRoot, 'scratch'),
      docker: async (args: string[]) => {
        calls.push(args);
        return { exitCode: 0, stdout: args[0] === 'image' ? image : args[0] === 'inspect' ? '{}' : args.includes('test') ? 'fixture test evidence' : '', stderr: '' };
      },
    }));
    try { await executeReview('acme', 'payments', 123, makeState()); }
    finally { config.trustedNodeImages = old; }
    expect(calls.find(args => args[0] === 'run')).toContain(image);
    expect(calls.some(args => args[0] === 'exec' && args.includes('test'))).toBe(true);
    const html = fs.readFileSync(path.join(reportDirectory(), `acme__payments__123__${pinnedHeadSha}.html`), 'utf8');
    expect(html).toContain('fixture test evidence');
    expect(html).toContain('ignore-scripts');
  });

  it('blocks isolated execution when the local checkout has uncommitted review-agent changes', async () => {
    const state = makeState();
    mockRunReviewVerificationGate.mockImplementationOnce(async (args: { publish: (draft: ReviewDraft) => Promise<void> }) => {
      const draft = verifiedDraft();
      fs.writeFileSync(path.join(checkoutPath, 'tracked.txt'), 'modified during verification\n');
      await args.publish(draft);
      return draft;
    });

    const result = await executeReview('acme', 'payments', 123, state);

    expect(result).toMatchObject({ success: true, verdict: 'awaiting_human_review', commentPosted: true });
    expect(mockRunReviewTestRunner).not.toHaveBeenCalled();
    const html = fs.readFileSync(path.join(reportDirectory(), `acme__payments__123__${pinnedHeadSha}.html`), 'utf8');
    expect(html).toContain('차단됨');
    expect(html).toContain('checkout no longer matched');
  });

  it.each([
    ['when no local clone is available', { ok: false, reason: 'auth_failed' }],
    ['when the clone SHA differs from the pinned PR head', { ok: true, path: '/untrusted/mismatched-checkout', headSha: 'c'.repeat(40) }],
  ])('%s skips local execution and records a blocked test status', async (_label, cloneResult) => {
    const state = makeState();
    mockCloneRepoForPR.mockResolvedValue(cloneResult);

    const result = await executeReview('acme', 'payments', 123, state);

    expect(result).toMatchObject({ success: true, verdict: 'awaiting_human_review', commentPosted: true });
    expect(mockRunReviewTestRunner).not.toHaveBeenCalled();
    expect(mockPostInlineReview).toHaveBeenCalledWith(
      'acme', 'payments', 123, pinnedHeadSha, expect.any(String), 'COMMENT', [], state, 'author',
    );
    expect(mockRunReviewVerificationGate).toHaveBeenCalledWith(expect.objectContaining({ clonePath: undefined }));
    const html = fs.readFileSync(path.join(reportDirectory(), `acme__payments__123__${pinnedHeadSha}.html`), 'utf8');
    expect(html).toContain('차단됨');
    expect(html).toContain('not run');
  });

  it.each([
    ['the exact diff is missing', ''],
    ['the diff has no before/after hunk pair', DIFF.replace('-const value = "before";\n', '')],
  ])('%s prevents publication without exact evidence', async (caseName, diff) => {
    const state = makeState();
    mockGetPRDiff.mockResolvedValue(diff);
    if (caseName.includes('base SHA')) mockGetPRDetails.mockResolvedValue(makeDetails(pinnedHeadSha, ''));

    await expect(executeReview('acme', 'payments', 123, state)).rejects.toThrow();
    expect(mockPostInlineReview).not.toHaveBeenCalled();
    expect(mockRunReviewTestRunner).not.toHaveBeenCalled();
    expect(fs.existsSync(reportDirectory())).toBe(false);

  });

  it.each([
    ['binary modification', 'diff --git a/a.png b/a.png\nindex 1111111..2222222 100644\nBinary files a/a.png and b/a.png differ\n'],
    ['binary addition', 'diff --git a/a.png b/a.png\nnew file mode 100644\nindex 0000000..1234567\nBinary files /dev/null and b/a.png differ\n'],
    ['binary deletion', 'diff --git a/a.png b/a.png\ndeleted file mode 100644\nindex 1234567..0000000\nBinary files a/a.png and /dev/null differ\n'],
    ['mode change', 'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n'],
    ['rename', 'diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n'],
  ])('publishes and generates a grounded report for %s', async (_label, diff) => {
    const state = makeState();
    mockGetPRDiff.mockResolvedValue(diff);
    const result = await executeReview('acme', 'payments', 123, state);
    expect(result).toMatchObject({ success: true, commentPosted: true });
    expect(mockPostInlineReview).toHaveBeenCalledTimes(1);
    const html = fs.readFileSync(path.join(reportDirectory(), `acme__payments__123__${pinnedHeadSha}.html`), 'utf8');
    expect(html).toContain('텍스트 내용은 확인할 수 없습니다');
  });

  it('rejects incomplete metadata before publishing', async () => {
    const state = makeState();
    mockGetPRDiff.mockResolvedValue('diff --git a/run.sh b/run.sh\nold mode 100644\n');
    await expect(executeReview('acme', 'payments', 123, state)).rejects.toThrow();
    expect(mockPostInlineReview).not.toHaveBeenCalled();
    expect(postReviewCommentReply).not.toHaveBeenCalled();
  });

  it('persists the verified draft privately before the first GitHub write', async () => {
    const state = new ReviewedPRsState(path.join(testRoot, 'review-state.json'));
    mockPostInlineReview.mockImplementationOnce(async () => {
      expect(readReportOutbox('acme', 'payments', 123, pinnedHeadSha)?.diff).toBe(DIFF);
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const name = path.join(dir, entry.name);
          if (entry.isDirectory() && entry.name !== 'checkout') walk(name);
          else if (entry.isFile()) files.push(name);
        }
      };
      walk(testRoot);
      const drafts = files.filter(file => fs.readFileSync(file, 'utf8').includes('Verified human review summary.'));
      expect(drafts.length).toBeGreaterThan(0);
      for (const file of drafts) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });
    await executeReview('acme', 'payments', 123, state);
  });

  it('recovers without posting existing-thread replies again', async () => {
    const statePath = path.join(testRoot, 'review-state.json');
    const state = new ReviewedPRsState(statePath);
    jest.spyOn(reportStore, 'storeReviewReportHtml').mockImplementationOnce(() => { throw new Error('temporary report failure'); });
    mockRunReviewVerificationGate.mockImplementationOnce(async (args: { publish: (draft: ReviewDraft) => Promise<void> }) => {
      const draft = { ...verifiedDraft(), replies: [{ commentId: 42, severity: 'minor' as const, body: 'Verified reply' }] };
      await args.publish(draft);
      return draft;
    });
    await executeReview('acme', 'payments', 123, state);
    const restarted = new ReviewedPRsState(statePath);
    restarted.load();
    await executeReview('acme', 'payments', 123, restarted);
    expect(postReviewCommentReply).toHaveBeenCalledTimes(1);
    expect(mockPostInlineReview).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(reportDirectory(), `acme__payments__123__${pinnedHeadSha}.html`))).toBe(true);
  });

  it('recovers a failed report on the same HEAD after restart without repeating GitHub writes', async () => {
    const statePath = path.join(testRoot, 'review-state.json');
    const state = new ReviewedPRsState(statePath);
    jest.spyOn(reportStore, 'storeReviewReportHtml').mockImplementationOnce(() => { throw new Error('temporary report failure'); });

    await executeReview('acme', 'payments', 123, state);
    expect(mockPostInlineReview).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(reportDirectory())).toBe(false);

    const restartedState = new ReviewedPRsState(statePath);
    restartedState.load();
    await executeReview('acme', 'payments', 123, restartedState);

    expect(mockPostInlineReview).toHaveBeenCalledTimes(1);
    expect(mockRunReviewVerificationGate).toHaveBeenCalledTimes(1);
    const html = fs.readFileSync(path.join(reportDirectory(), `acme__payments__123__${pinnedHeadSha}.html`), 'utf8');
    expect(html).toContain('Verified human review summary.');
    expect(html).toContain(pinnedHeadSha);
  });

  it('publishes with canonical cwd state and recovers its report without a second POST', async () => {
    const file = path.join(testRoot, 'state', 'reviewed-prs.json');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ reviewedPRs: {}, repliedComments: { old: { commentedAt: 'retained' } } }));
    const state = new ReviewedPRsState(); state.load();
    expect(state.stateFilePath).toBe(file);
    const axios = require('axios').default;
    jest.spyOn(axios, 'get').mockImplementation(async (...args: unknown[]) => ({ data: String(args[0]).endsWith('/user') ? { login: 'bot' } : [], headers: {} }));
    const post = jest.spyOn(axios, 'post').mockResolvedValue({ data: { id: 999, state: 'COMMENTED' }, headers: {} });
    mockPostInlineReview.mockImplementationOnce(jest.requireActual('../src/github').postInlineReview);
    jest.spyOn(reportStore, 'storeReviewReportHtml').mockImplementationOnce(() => { throw new Error('report storage unavailable'); });
    await expect(executeReview('acme', 'payments', 123, state)).resolves.toMatchObject({ success: true });
    expect(post).toHaveBeenCalledTimes(1);
    expect(readReportOutbox('acme', 'payments', 123, pinnedHeadSha)?.status).toBe('published');
    const restarted = new ReviewedPRsState(); restarted.load();
    expect(restarted.isCommentReplied('old')).toBe(true);
    expect(restarted.getReviewPublication(`acme/payments#123:${pinnedHeadSha}`)).toMatchObject({ status: 'completed', reviewId: 999 });
    await executeReview('acme', 'payments', 123, restarted, pinnedHeadSha);
    expect(post).toHaveBeenCalledTimes(1);
    expect(mockPostInlineReview).toHaveBeenCalledTimes(1);
    expect(readReportOutbox('acme', 'payments', 123, pinnedHeadSha)).toBeNull();
    expect(fs.readFileSync(path.join(reportDirectory(), `acme__payments__123__${pinnedHeadSha}.html`), 'utf8')).toContain('Verified human review summary.');
  });

  it('retries a no-reply formal publication after a transient pre-write login failure', async () => {
    const file = path.join(testRoot, 'review-state.json');
    const state = new ReviewedPRsState(file);
    state.markPRReviewing('acme', 'payments', 123, pinnedHeadSha);
    mockPostInlineReview.mockRejectedValueOnce(new Error('Cannot publish GitHub review without the authenticated bot login'));
    await expect(executeReview('acme', 'payments', 123, state)).rejects.toThrow('before a confirmed write');
    expect(readReportOutbox('acme', 'payments', 123, pinnedHeadSha)?.publicationIntent).toBe('unattempted');
    const restarted = new ReviewedPRsState(file); restarted.load();
    mockPostInlineReview.mockRejectedValueOnce(new Error('login still unavailable'));
    await expect(executeReview('acme', 'payments', 123, restarted)).rejects.toThrow('before a confirmed write');
    expect(readReportOutbox('acme', 'payments', 123, pinnedHeadSha)?.publicationIntent).toBe('unattempted');
    await executeReview('acme', 'payments', 123, restarted);
    expect(mockPostInlineReview).toHaveBeenCalledTimes(3);
  });

  it.each(['initial', 'recovery'])('preserves the sanitized original pre-write error during %s publication', async mode => {
    const file = path.join(testRoot, 'review-state.json');
    const state = new ReviewedPRsState(file);
    state.markPRReviewing('acme', 'payments', 123, pinnedHeadSha);
    if (mode === 'recovery') writeReportOutbox({ owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, details: makeDetails(pinnedHeadSha), draft: verifiedDraft(), diff: DIFF, status: 'prepared', publicationIntent: 'unattempted' });
    const original = Object.assign(new Error('login lookup failed: Bearer private-credential\nforged log'), {
      code: 'ECONNRESET', response: { status: 503, data: 'private-response' }, config: { headers: { authorization: 'private-credential' } },
    });
    mockPostInlineReview.mockRejectedValueOnce(original);
    const failure = await executeReview('acme', 'payments', 123, state).catch(error => error);
    expect(failure).toMatchObject({ name: 'ReportRecoveryError', cause: { message: expect.stringContaining('login lookup failed'), code: 'ECONNRESET', status: 503 } });
    expect(failure.message).toContain('login lookup failed');
    expect(failure.message).toContain('ECONNRESET');
    expect(failure.cause).not.toBe(original);
    expect(failure.cause.config).toBeUndefined();
    expect(failure.cause.response).toBeUndefined();
    expect(JSON.stringify(failure) + failure.message + failure.cause.message).not.toMatch(/private-credential|private-response|\nforged/);
    expect(readReportOutbox('acme', 'payments', 123, pinnedHeadSha)?.publicationIntent).toBe('unattempted');
  });

  it.each(['matching', 'marker', 'body', 'comments', 'identity', 'attempted', 'completed'])('classifies a %s durable reservation without speculative replay', async variant => {
    const state = new ReviewedPRsState(path.join(testRoot, 'review-state.json'));
    state.markPRReviewing('acme', 'payments', 123, pinnedHeadSha);
    mockPostInlineReview.mockImplementationOnce(async () => {
      const posting = prepareReviewForPosting(verifiedDraft());
      const digest = createHash('sha256').update(JSON.stringify({ owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, body: posting.body, comments: posting.comments })).digest('hex').slice(0, 24);
      const marker = `<!-- pr-reviewer-bot:review:${digest} -->`;
      const key = `acme/payments#123:${pinnedHeadSha}`;
      state.reserveReviewPublication(key, {
        owner: variant === 'identity' ? 'other' : 'acme', repo: 'payments', prNumber: 123,
        headSha: pinnedHeadSha, botLogin: 'bot',
        pendingBody: variant === 'body' ? 'different body' : `${marker}\n${posting.body}`,
        pendingEvent: 'COMMENT', pendingComments: variant === 'comments' ? [{ path: 'other.ts', line: 1, side: 'RIGHT', body: 'different' }] : posting.comments,
        operationMarker: variant === 'marker' ? '<!-- different -->' : marker,
      });
      if (variant === 'attempted') state.markReviewPublicationPostAttempted(key);
      if (variant === 'completed') state.completeReviewPublication(key, 12345);
      throw new Error('prerequisite reconciliation read unavailable');
    });
    await expect(executeReview('acme', 'payments', 123, state)).rejects.toMatchObject({ name: variant === 'matching' ? 'ReportRecoveryError' : 'ReportPublicationAmbiguousError', cause: { message: 'prerequisite reconciliation read unavailable' } });
    if (variant === 'matching' || variant === 'completed') {
      await executeReview('acme', 'payments', 123, state);
    } else {
      await expect(executeReview('acme', 'payments', 123, state)).rejects.toThrow('ambiguous');
    }
    expect(mockRunReviewVerificationGate).toHaveBeenCalledTimes(1);
    expect(mockPostInlineReview).toHaveBeenCalledTimes(variant === 'matching' ? 2 : 1);
  });

  it('preserves the original failure and lock-inspection failure without guessing delivery', async () => {
    const file = path.join(testRoot, 'review-state.json');
    const state = new ReviewedPRsState(file);
    state.markPRReviewing('acme', 'payments', 123, pinnedHeadSha);
    mockPostInlineReview.mockImplementationOnce(async () => {
      fs.writeFileSync(`${file}.review-publication.lock`, 'another publisher');
      expect(state.reserveReviewPublication('unused', {} as any)).toBe(false);
      throw new Error('Failed to reserve GitHub review publication');
    });
    const failure = await executeReview('acme', 'payments', 123, state).catch(error => error);
    expect(failure).toMatchObject({ name: 'ReportPublicationAmbiguousError', cause: { message: 'Failed to reserve GitHub review publication' }, stateInspectionError: { message: 'Cannot inspect durable review publication state' } });
    expect(failure.message).toContain('Failed to reserve GitHub review publication');
    expect(failure.message).toContain('Cannot inspect durable review publication state');
    await expect(executeReview('acme', 'payments', 123, state)).rejects.toMatchObject({ name: 'ReportPublicationAmbiguousError', cause: { message: 'Cannot inspect durable review publication state' } });
    expect(mockPostInlineReview).toHaveBeenCalledTimes(1);
    expect(postReviewCommentReply).not.toHaveBeenCalled();
  });

  it('never repeats an ambiguous publication after restart', async () => {
    const statePath = path.join(testRoot, 'review-state.json');
    const state = new ReviewedPRsState(statePath);
    state.markPRReviewing('acme', 'payments', 123);
    mockPostInlineReview.mockImplementationOnce(async () => {
      const posting = prepareReviewForPosting(verifiedDraft());
      const digest = createHash('sha256').update(JSON.stringify({ owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, body: posting.body, comments: posting.comments })).digest('hex').slice(0, 24);
      const key = `acme/payments#123:${pinnedHeadSha}`;
      state.reserveReviewPublication(key, { owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, botLogin: 'bot', pendingBody: posting.body, pendingEvent: 'COMMENT', pendingComments: posting.comments, operationMarker: `<!-- pr-reviewer-bot:review:${digest} -->` });
      state.markReviewPublicationPostAttempted(key);
      throw new Error('connection lost after request');
    });
    await expect(executeReview('acme', 'payments', 123, state)).rejects.toThrow('ambiguous');
    const restarted = new ReviewedPRsState(statePath);
    restarted.load();
    await expect(executeReview('acme', 'payments', 123, restarted)).rejects.toThrow('ambiguous');
    expect(mockPostInlineReview).toHaveBeenCalledTimes(1);
    expect(mockRunReviewVerificationGate).toHaveBeenCalledTimes(1);
  });

  it('recovers after the prepared snapshot is durable but the attempt boundary fails', async () => {
    const file = path.join(testRoot, 'review-state.json');
    const state = new ReviewedPRsState(file);
    state.markPRReviewing('acme', 'payments', 123, pinnedHeadSha);
    const draft = { ...verifiedDraft(), replies: [{ commentId: 42, severity: 'minor' as const, body: 'reply' }] };
    mockRunReviewVerificationGate.mockImplementationOnce(async (args: { publish: (value: ReviewDraft) => Promise<void> }) => { await args.publish(draft); return draft; });
    const original = reportOutbox.writeReportOutbox;
    const spy = jest.spyOn(reportOutbox, 'writeReportOutbox').mockImplementation(entry => {
      if (entry.publicationIntent === 'attempted') throw new Error('crash before attempt boundary');
      original(entry);
    });
    await expect(executeReview('acme', 'payments', 123, state)).rejects.toThrow();
    spy.mockRestore();
    expect(readReportOutbox('acme', 'payments', 123, pinnedHeadSha)?.publicationIntent).toBe('unattempted');
    expect(postReviewCommentReply).not.toHaveBeenCalled();
    const restarted = new ReviewedPRsState(file); restarted.load();
    await executeReview('acme', 'payments', 123, restarted);
    expect(postReviewCommentReply).toHaveBeenCalledTimes(1);
    expect(mockPostInlineReview).toHaveBeenCalledTimes(1);
  });

  it('never repeats a possibly posted reply after a transport failure', async () => {
    const file = path.join(testRoot, 'review-state.json');
    const state = new ReviewedPRsState(file);
    state.markPRReviewing('acme', 'payments', 123, pinnedHeadSha);
    const draft = { ...verifiedDraft(), replies: [{ commentId: 42, severity: 'minor' as const, body: 'reply' }] };
    mockRunReviewVerificationGate.mockImplementationOnce(async (args: { publish: (value: ReviewDraft) => Promise<void> }) => { await args.publish(draft); return draft; });
    (postReviewCommentReply as jest.Mock).mockRejectedValueOnce(new Error('response lost'));
    await expect(executeReview('acme', 'payments', 123, state)).rejects.toThrow('ambiguous');
    expect(readReportOutbox('acme', 'payments', 123, pinnedHeadSha)?.publicationIntent).toBe('attempted');
    const restarted = new ReviewedPRsState(file); restarted.load();
    await expect(executeReview('acme', 'payments', 123, restarted)).rejects.toThrow('ambiguous');
    expect(postReviewCommentReply).toHaveBeenCalledTimes(1);
    expect(mockPostInlineReview).not.toHaveBeenCalled();
  });

  it('resumes a provably unattempted reply draft exactly once after restart', async () => {
    const state = new ReviewedPRsState(path.join(testRoot, 'review-state.json'));
    state.markPRReviewing('acme', 'payments', 123);
    const draft = { ...verifiedDraft(), replies: [{ commentId: 42, severity: 'minor' as const, body: 'reply' }] };
    writeReportOutbox({ owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, details: makeDetails(pinnedHeadSha), draft, diff: DIFF, status: 'prepared', publicationIntent: 'unattempted' } as any);
    await executeReview('acme', 'payments', 123, state);
    await executeReview('acme', 'payments', 123, state);
    expect(postReviewCommentReply).toHaveBeenCalledTimes(1);
    expect(mockPostInlineReview).toHaveBeenCalledTimes(1);
  });

  it.each(['head', 'base', 'failure'])('refuses unattempted reply recovery on revision %s', async change => {
    const state = new ReviewedPRsState(path.join(testRoot, 'review-state.json'));
    state.markPRReviewing('acme', 'payments', 123);
    const draft = { ...verifiedDraft(), replies: [{ commentId: 42, severity: 'minor' as const, body: 'reply' }] };
    writeReportOutbox({ owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, details: makeDetails(pinnedHeadSha), draft, diff: DIFF, status: 'prepared', publicationIntent: 'unattempted' } as any);
    if (change === 'failure') mockGetPRDetails.mockRejectedValue(new Error('unavailable'));
    else mockGetPRDetails.mockResolvedValue(makeDetails(change === 'head' ? 'b'.repeat(40) : pinnedHeadSha, change === 'base' ? 'c'.repeat(40) : 'a'.repeat(40)));
    await expect(executeReview('acme', 'payments', 123, state, pinnedHeadSha)).rejects.toThrow();
    expect(postReviewCommentReply).not.toHaveBeenCalled();
    expect(mockPostInlineReview).not.toHaveBeenCalled();
  });

  it('never retries an attempted reply publication after a crash', async () => {
    const state = new ReviewedPRsState(path.join(testRoot, 'review-state.json'));
    state.markPRReviewing('acme', 'payments', 123);
    const draft = { ...verifiedDraft(), replies: [{ commentId: 42, severity: 'minor' as const, body: 'reply' }] };
    writeReportOutbox({ owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, details: makeDetails(pinnedHeadSha), draft, diff: DIFF, status: 'prepared', publicationIntent: 'attempted' } as any);
    await expect(executeReview('acme', 'payments', 123, state)).rejects.toThrow('ambiguous');
    expect(postReviewCommentReply).not.toHaveBeenCalled();
    expect(mockPostInlineReview).not.toHaveBeenCalled();
  });

  it('does not publish an initial review when the diff is unavailable', async () => {
    mockGetPRDiff.mockRejectedValue(new Error('diff unavailable'));
    await expect(executeReview('acme', 'payments', 123, makeState())).rejects.toThrow();
    expect(mockPostInlineReview).not.toHaveBeenCalled();
    expect(postReviewCommentReply).not.toHaveBeenCalled();
  });

  it.each(['invalid', 'unavailable'])('does not write a legacy unattempted publication when diff is %s', async condition => {
    const state = new ReviewedPRsState(path.join(testRoot, 'review-state.json'));
    state.markPRReviewing('acme', 'payments', 123, pinnedHeadSha);
    writeReportOutbox({ owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, details: makeDetails(pinnedHeadSha), draft: verifiedDraft(), status: 'prepared' });
    if (condition === 'invalid') mockGetPRDiff.mockResolvedValue('');
    else mockGetPRDiff.mockRejectedValue(new Error('diff unavailable'));
    await expect(executeReview('acme', 'payments', 123, state)).rejects.toThrow();
    expect(mockPostInlineReview).not.toHaveBeenCalled();
    expect(postReviewCommentReply).not.toHaveBeenCalled();
  });

  it.each(['initial', 'recovery'])('rejects an unrenderable uncertainty reason before %s publication', async mode => {
    const draft: ReviewDraft = { ...verifiedDraft(), comments: [{ path: 'src/service.ts', line: 10, side: 'RIGHT', severity: 'minor', kind: 'finding', body: 'A finding', verification: { confidence: 'uncertain', uncertaintyReason: 'bad\u0001reason' } }] };
    const state = new ReviewedPRsState(path.join(testRoot, 'review-state.json'));
    state.markPRReviewing('acme', 'payments', 123, pinnedHeadSha);
    if (mode === 'recovery') writeReportOutbox({ owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, details: makeDetails(pinnedHeadSha), draft, diff: DIFF, status: 'prepared', publicationIntent: 'unattempted' });
    else mockRunReviewVerificationGate.mockImplementationOnce(async (args: { publish: (value: ReviewDraft) => Promise<void> }) => { await args.publish(draft); return draft; });
    await expect(executeReview('acme', 'payments', 123, state)).rejects.toThrow();
    expect(mockPostInlineReview).not.toHaveBeenCalled();
    expect(postReviewCommentReply).not.toHaveBeenCalled();
  });

  it('resumes a prepared no-reply draft after a pre-publication lookup failure', async () => {
    const state = new ReviewedPRsState(path.join(testRoot, 'review-state.json'));
    state.markPRReviewing('acme', 'payments', 123);
    writeReportOutbox({ owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, details: makeDetails(pinnedHeadSha), draft: verifiedDraft(), status: 'prepared' });
    mockPostInlineReview.mockImplementationOnce(async () => {
      expect(readReportOutbox('acme', 'payments', 123, pinnedHeadSha)?.diff).toBe(DIFF);
      mockGetPRDiff.mockRejectedValue(new Error('must use persisted snapshot'));
    });
    await executeReview('acme', 'payments', 123, state);
    expect(mockPostInlineReview).toHaveBeenCalledTimes(1);
    expect(mockGetPRDiff).toHaveBeenCalledTimes(1);
    expect(mockRunReviewVerificationGate).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(reportDirectory(), `acme__payments__123__${pinnedHeadSha}.html`))).toBe(true);
  });

  it.each(['matching', 'mismatched'])('handles an unattempted %s reservation without guessing', async markerCase => {
    const state = new ReviewedPRsState(path.join(testRoot, 'review-state.json'));
    state.markPRReviewing('acme', 'payments', 123);
    const draft = verifiedDraft();
    const posting = prepareReviewForPosting(draft);
    const digest = createHash('sha256').update(JSON.stringify({ owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, body: posting.body, comments: posting.comments })).digest('hex').slice(0, 24);
    writeReportOutbox({ owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, details: makeDetails(pinnedHeadSha), draft, status: 'prepared' });
    state.reserveReviewPublication(`acme/payments#123:${pinnedHeadSha}`, { owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, botLogin: 'bot', pendingBody: `<!-- pr-reviewer-bot:review:${digest} -->\n${posting.body}`, pendingEvent: 'COMMENT', pendingComments: posting.comments, operationMarker: markerCase === 'matching' ? `<!-- pr-reviewer-bot:review:${digest} -->` : '<!-- different -->' });
    if (markerCase === 'matching') {
      await executeReview('acme', 'payments', 123, state);
      expect(mockPostInlineReview).toHaveBeenCalledTimes(1);
    } else {
      await expect(executeReview('acme', 'payments', 123, state)).rejects.toThrow('ambiguous');
      expect(mockPostInlineReview).not.toHaveBeenCalled();
    }
  });

  it.each(['APPROVE', 'REQUEST_CHANGES'] as const)('recovers a matching unattempted legacy %s reservation', async event => {
    const file = path.join(testRoot, 'review-state.json');
    const state = new ReviewedPRsState(file);
    state.markPRReviewing('acme', 'payments', 123);
    const draft = verifiedDraft();
    const posting = prepareReviewForPosting(draft);
    const digest = createHash('sha256').update(JSON.stringify({ owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, body: posting.body, comments: posting.comments })).digest('hex').slice(0, 24);
    const marker = `<!-- pr-reviewer-bot:review:${digest} -->`;
    writeReportOutbox({ owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, details: makeDetails(pinnedHeadSha), draft, diff: DIFF, status: 'prepared' });
    state.reserveReviewPublication(`acme/payments#123:${pinnedHeadSha}`, { owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, botLogin: 'bot', pendingBody: `${marker}\n${posting.body}`, pendingEvent: event, pendingComments: posting.comments, operationMarker: marker });
    const axios = require('axios').default;
    jest.spyOn(axios, 'get').mockImplementation(async (...args: unknown[]) => ({ data: String(args[0]).endsWith('/user') ? { login: 'bot' } : [], headers: {} }));
    const post = jest.spyOn(axios, 'post').mockResolvedValue({ data: { id: 16, state: 'COMMENTED' }, headers: {} });
    mockPostInlineReview.mockImplementationOnce(jest.requireActual('../src/github').postInlineReview);
    await expect(executeReview('acme', 'payments', 123, state)).resolves.toMatchObject({ success: true });
    expect(mockPostInlineReview).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1]).toMatchObject({ event: 'COMMENT', body: `${marker}\n${posting.body}` });
    expect(postReviewCommentReply).not.toHaveBeenCalled();
  });

  it('fails closed if durable publication state is missing', async () => {
    const state = new ReviewedPRsState(path.join(testRoot, 'missing-state.json'));
    writeReportOutbox({ owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, details: makeDetails(pinnedHeadSha), draft: verifiedDraft(), status: 'prepared' });
    await expect(executeReview('acme', 'payments', 123, state)).rejects.toThrow('ambiguous');
    expect(mockPostInlineReview).not.toHaveBeenCalled();
  });

  it.each([
    ['missing title', 'title', undefined],
    ['empty title', 'title', ''],
    ['whitespace title', 'title', '  \t '],
    ['overlong title', 'title', 'x'.repeat(241)],
    ['control character title', 'title', 'bad\u0001title'],
    ['whitespace base ref', 'baseRefName', '  '],
    ['overlong head ref', 'headRefName', 'x'.repeat(241)],
    ['invalid base SHA', 'baseSha', 'invalid'],
  ])('blocks initial publication for %s', async (_label, field, value) => {
    const details = { ...makeDetails(pinnedHeadSha), [field]: value };
    mockGetPRDetails.mockResolvedValue(details);
    mockRunReviewVerificationGate.mockImplementationOnce(async (args: { publish: (draft: ReviewDraft) => Promise<void> }) => {
      const draft = { ...verifiedDraft(), replies: [{ commentId: 42, severity: 'minor' as const, body: 'reply' }] };
      await args.publish(draft);
      return draft;
    });
    await expect(executeReview('acme', 'payments', 123, makeState())).rejects.toThrow();
    expect(mockPostInlineReview).not.toHaveBeenCalled();
    expect(postReviewCommentReply).not.toHaveBeenCalled();
  });

  it.each([
    ['missing title', 'title', undefined],
    ['empty title', 'title', ''],
    ['whitespace title', 'title', '  \t '],
    ['overlong title', 'title', 'x'.repeat(241)],
    ['control character title', 'title', 'bad\u0001title'],
    ['whitespace base ref', 'baseRefName', '  '],
    ['overlong head ref', 'headRefName', 'x'.repeat(241)],
    ['invalid base SHA', 'baseSha', 'invalid'],
  ])('blocks unattempted recovery publication for %s', async (_label, field, value) => {
    const state = new ReviewedPRsState(path.join(testRoot, 'review-state.json'));
    state.markPRReviewing('acme', 'payments', 123, pinnedHeadSha);
    const details = { ...makeDetails(pinnedHeadSha), [field]: value };
    const draft = { ...verifiedDraft(), replies: [{ commentId: 42, severity: 'minor' as const, body: 'reply' }] };
    writeReportOutbox({ owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, details, draft, diff: DIFF, status: 'prepared', publicationIntent: 'unattempted' } as any);
    mockGetPRDetails.mockResolvedValue(details);
    await expect(executeReview('acme', 'payments', 123, state, pinnedHeadSha)).rejects.toThrow();
    expect(mockPostInlineReview).not.toHaveBeenCalled();
    expect(postReviewCommentReply).not.toHaveBeenCalled();
  });

  it('does not publish when authoritative report metadata is unavailable', async () => {
    const state = new ReviewedPRsState(path.join(testRoot, 'review-state.json'));
    mockGetPRDetails.mockRejectedValue(new Error('metadata unavailable'));
    await expect(executeReview('acme', 'payments', 123, state)).rejects.toThrow();
    expect(mockPostInlineReview).not.toHaveBeenCalled();
    expect(postReviewCommentReply).not.toHaveBeenCalled();
    expect(readReportOutbox('acme', 'payments', 123, pinnedHeadSha)).toBeNull();
  });

  it('recovers a prepared report when the exact no-reply formal review is durably completed', async () => {
    const state = new ReviewedPRsState(path.join(testRoot, 'review-state.json'));
    const draft = verifiedDraft();
    const posting = prepareReviewForPosting(draft);
    const digest = createHash('sha256').update(JSON.stringify({ owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, body: posting.body, comments: posting.comments })).digest('hex').slice(0, 24);
    writeReportOutbox({ owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, details: makeDetails(pinnedHeadSha), draft, status: 'prepared' });
    const key = `acme/payments#123:${pinnedHeadSha}`;
    state.markPRReviewing('acme', 'payments', 123);
    state.reserveReviewPublication(key, { owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, botLogin: 'bot', pendingBody: posting.body, pendingEvent: 'COMMENT', pendingComments: posting.comments, operationMarker: `<!-- pr-reviewer-bot:review:${digest} -->` });
    state.completeReviewPublication(key, 1);
    await executeReview('acme', 'payments', 123, state);
    expect(state.isPRCompleted('acme', 'payments', 123)).toBe(true);
    expect(mockPostInlineReview).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(reportDirectory(), `acme__payments__123__${pinnedHeadSha}.html`))).toBe(true);
  });

  it('reconciles an attempted exact formal review before recovering its report', async () => {
    const state = new ReviewedPRsState(path.join(testRoot, 'review-state.json'));
    const draft = verifiedDraft();
    const posting = prepareReviewForPosting(draft);
    const digest = createHash('sha256').update(JSON.stringify({ owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, body: posting.body, comments: posting.comments })).digest('hex').slice(0, 24);
    const key = `acme/payments#123:${pinnedHeadSha}`;
    writeReportOutbox({ owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, details: makeDetails(pinnedHeadSha), draft, status: 'prepared' });
    state.markPRReviewing('acme', 'payments', 123);
    state.reserveReviewPublication(key, { owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, botLogin: 'bot', pendingBody: posting.body, pendingEvent: 'COMMENT', pendingComments: posting.comments, operationMarker: `<!-- pr-reviewer-bot:review:${digest} -->` });
    state.markReviewPublicationPostAttempted(key);
    const reconcile = require('../src/github').reconcileAttemptedReviewPublication as jest.Mock;
    reconcile.mockResolvedValueOnce(true);
    await executeReview('acme', 'payments', 123, state);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(mockPostInlineReview).not.toHaveBeenCalled();
    expect(postReviewCommentReply).not.toHaveBeenCalled();
    expect(state.isPRCompleted('acme', 'payments', 123)).toBe(true);
  });

  it('leaves partial reply publications ambiguous without reconciliation or reposting', async () => {
    const state = new ReviewedPRsState(path.join(testRoot, 'review-state.json'));
    const draft = { ...verifiedDraft(), replies: [{ commentId: 42, severity: 'minor' as const, body: 'reply' }] };
    const posting = prepareReviewForPosting(draft);
    const digest = createHash('sha256').update(JSON.stringify({ owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, body: posting.body, comments: posting.comments })).digest('hex').slice(0, 24);
    const key = `acme/payments#123:${pinnedHeadSha}`;
    writeReportOutbox({ owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, details: makeDetails(pinnedHeadSha), draft, status: 'prepared' });
    state.markPRReviewing('acme', 'payments', 123);
    state.reserveReviewPublication(key, { owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, botLogin: 'bot', pendingBody: posting.body, pendingEvent: 'COMMENT', pendingComments: posting.comments, operationMarker: `<!-- pr-reviewer-bot:review:${digest} -->` });
    state.markReviewPublicationPostAttempted(key);
    await expect(executeReview('acme', 'payments', 123, state)).rejects.toThrow('ambiguous');
    expect(require('../src/github').reconcileAttemptedReviewPublication).not.toHaveBeenCalled();
    expect(mockPostInlineReview).not.toHaveBeenCalled();
    expect(postReviewCommentReply).not.toHaveBeenCalled();
  });

  it('classifies failure to persist reconciled outbox as recovery failure', async () => {
    const state = new ReviewedPRsState(path.join(testRoot, 'review-state.json'));
    const draft = verifiedDraft();
    const posting = prepareReviewForPosting(draft);
    const digest = createHash('sha256').update(JSON.stringify({ owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, body: posting.body, comments: posting.comments })).digest('hex').slice(0, 24);
    const key = `acme/payments#123:${pinnedHeadSha}`;
    writeReportOutbox({ owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, details: makeDetails(pinnedHeadSha), draft, status: 'prepared' });
    state.markPRReviewing('acme', 'payments', 123);
    state.reserveReviewPublication(key, { owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, botLogin: 'bot', pendingBody: posting.body, pendingEvent: 'COMMENT', pendingComments: posting.comments, operationMarker: `<!-- pr-reviewer-bot:review:${digest} -->` });
    state.completeReviewPublication(key, 1);
    const rename = jest.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk failure'); });
    try {
      await expect(executeReview('acme', 'payments', 123, state)).rejects.toMatchObject({ name: 'ReportRecoveryError' });
    } finally { rename.mockRestore(); }
  });

  it('reports report recovery failure instead of success', async () => {
    const state = new ReviewedPRsState(path.join(testRoot, 'review-state.json'));
    state.markPRReviewing('acme', 'payments', 123);
    writeReportOutbox({ owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, details: makeDetails(pinnedHeadSha), draft: verifiedDraft(), status: 'published' });
    mockGetPRDiff.mockRejectedValueOnce(new Error('temporary diff failure'));
    await expect(executeReview('acme', 'payments', 123, state)).rejects.toThrow('temporary diff failure');
  });

  it('retains the published outbox when report directory sync fails', async () => {
    const state = new ReviewedPRsState(path.join(testRoot, 'review-state.json'));
    const entry = { owner: 'acme', repo: 'payments', prNumber: 123, headSha: pinnedHeadSha, details: makeDetails(pinnedHeadSha), draft: verifiedDraft(), status: 'published' as const };
    writeReportOutbox(entry);
    fs.mkdirSync(reportDirectory(), { recursive: true });
    const realSync = fs.fsyncSync;
    const reportInode = fs.statSync(reportDirectory()).ino;
    const sync = jest.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (fs.fstatSync(fd).ino === reportInode) throw new Error('directory sync failed');
      return realSync(fd);
    });
    try {
      await expect(executeReview('acme', 'payments', 123, state)).rejects.toThrow('directory sync failed');
      expect(readReportOutbox('acme', 'payments', 123, pinnedHeadSha)).not.toBeNull();
      expect(mockPostInlineReview).not.toHaveBeenCalled();
    } finally { sync.mockRestore(); }
  });

  it('recovers published report when completion state was not persisted', async () => {
    const statePath = path.join(testRoot, 'review-state.json');
    const state = new ReviewedPRsState(statePath);
    jest.spyOn(reportStore, 'storeReviewReportHtml').mockImplementationOnce(() => { throw new Error('temporary report failure'); });
    jest.spyOn(state, 'markPRReviewed').mockImplementationOnce(() => { throw new Error('state write failed'); });
    await executeReview('acme', 'payments', 123, state);
    const restarted = new ReviewedPRsState(statePath);
    restarted.load();
    await executeReview('acme', 'payments', 123, restarted);
    expect(mockPostInlineReview).toHaveBeenCalledTimes(1);
    expect(restarted.isPRCompleted('acme', 'payments', 123)).toBe(true);
    expect(fs.existsSync(path.join(reportDirectory(), `acme__payments__123__${pinnedHeadSha}.html`))).toBe(true);
  });

  it('fails closed before any GitHub write when the private outbox path is a symlink', async () => {
    const state = makeState();
    fs.mkdirSync(path.join(testRoot, 'outside'), { recursive: true, mode: 0o700 });
    fs.symlinkSync(path.join(testRoot, 'outside'), path.join(testRoot, 'state'));
    await expect(executeReview('acme', 'payments', 123, state)).rejects.toThrow();
    expect(mockPostInlineReview).not.toHaveBeenCalled();
    expect(postReviewCommentReply).not.toHaveBeenCalled();
    expect(fs.readdirSync(path.join(testRoot, 'outside'))).toEqual([]);
  });
});
