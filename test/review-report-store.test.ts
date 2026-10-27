import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { storeReviewReportHtml } from '../src/review/review-report-store';

const originalRename = fs.renameSync;
const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('storeReviewReportHtml', () => {
  let root: string;
  let reportRoot: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'review-report-store-'));
    reportRoot = path.join(root, 'state', 'review-reports');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('stores one stable private artifact with owner/repository/PR/head naming', () => {
    const storedPath = storeReviewReportHtml({
      owner: 'Acme',
      repository: 'Payments',
      pullRequestNumber: 17,
      headSha: SHA,
      html: '<!doctype html><title>private</title>',
      reportRoot,
    });

    expect(path.basename(storedPath)).toBe(`acme__payments__17__${SHA}.html`);
    expect(fs.readFileSync(storedPath, 'utf8')).toBe('<!doctype html><title>private</title>');
    expect((fs.statSync(root).mode & 0o777).toString(8)).toBe('700');
    expect((fs.statSync(path.join(root, 'state')).mode & 0o777).toString(8)).toBe('700');
    expect((fs.statSync(reportRoot).mode & 0o777).toString(8)).toBe('700');
    expect((fs.statSync(storedPath).mode & 0o777).toString(8)).toBe('600');
  });

  it('syncs the report before rename and its directory after rename', () => {
    fs.mkdirSync(reportRoot, { recursive: true });
    const events: string[] = [];
    const sync = jest.spyOn(fs, 'fsyncSync').mockImplementation(fd => { events.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file'); });
    const rename = jest.spyOn(fs, 'renameSync').mockImplementation((a, b) => { events.push('rename'); return originalRename(a, b); });
    try {
      storeReviewReportHtml({ owner: 'acme', repository: 'repo', pullRequestNumber: 1, headSha: SHA, html: '<html/>', reportRoot });
      expect(events.slice(-3)).toEqual(['file', 'rename', 'directory']);
    } finally { sync.mockRestore(); rename.mockRestore(); }
  });

  it.each(['state', 'review-reports'])('retries the parent sync after creating %s fails to sync', component => {
    if (component === 'review-reports') fs.mkdirSync(path.join(root, 'state'));
    const parent = component === 'state' ? root : path.join(root, 'state');
    const parentInode = fs.statSync(parent).ino;
    const realSync = fs.fsyncSync.bind(fs);
    let fail = true;
    const events: string[] = [];
    const sync = jest.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (fs.fstatSync(fd).ino === parentInode) {
        events.push('parent sync');
        if (fail) { fail = false; throw new Error('parent sync failed'); }
      }
      realSync(fd);
    });
    const rename = jest.spyOn(fs, 'renameSync').mockImplementation((a, b) => {
      events.push('rename');
      return originalRename(a, b);
    });
    const options = { owner: 'acme', repository: 'repo', pullRequestNumber: 1, headSha: SHA, html: '<html/>', reportRoot };
    try {
      expect(() => storeReviewReportHtml(options)).toThrow('parent sync failed');
      expect(fs.existsSync(path.join(parent, component))).toBe(true);
      events.length = 0;
      storeReviewReportHtml(options);
      expect(events.indexOf('parent sync')).toBeGreaterThanOrEqual(0);
      expect(events.indexOf('parent sync')).toBeLessThan(events.indexOf('rename'));
    } finally { sync.mockRestore(); rename.mockRestore(); }
  });

  it('fails if report synchronization fails', () => {
    const sync = jest.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('sync failed'); });
    try {
      expect(() => storeReviewReportHtml({ owner: 'acme', repository: 'repo', pullRequestNumber: 1, headSha: SHA, html: '<html/>', reportRoot })).toThrow('sync failed');
    } finally { sync.mockRestore(); }
  });

  it.each([
    ['owner traversal', { owner: '../outside' }],
    ['repository traversal', { repository: '..' }],
    ['invalid PR number', { pullRequestNumber: 0 }],
    ['invalid SHA', { headSha: '../report' }],
  ])('rejects %s before constructing a path', (_label, override) => {
    expect(() => storeReviewReportHtml({
      owner: 'acme', repository: 'payments', pullRequestNumber: 17, headSha: SHA,
      html: '<html></html>', reportRoot, ...override,
    } as any)).toThrow('invalid report artifact identity');
    expect(fs.existsSync(root)).toBe(true);
    expect(fs.existsSync(path.join(root, 'state'))).toBe(false);
  });

  it('rejects a symlinked ancestor without writing through it', () => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.symlinkSync(outside, path.join(root, 'state'));

    expect(() => storeReviewReportHtml({
      owner: 'acme', repository: 'payments', pullRequestNumber: 17, headSha: SHA,
      html: '<html></html>', reportRoot,
    })).toThrow(/symlink/i);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('rejects overlarge HTML before writing an artifact', () => {
    expect(() => storeReviewReportHtml({
      owner: 'acme', repository: 'payments', pullRequestNumber: 17, headSha: SHA,
      html: 'x'.repeat(2_000_001), reportRoot,
    })).toThrow(/size limit/i);
    expect(fs.existsSync(path.join(root, 'state'))).toBe(false);
  });
});
