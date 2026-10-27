import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ReviewedPRsState from '../src/utils/state-manager';
import { deleteReportOutbox, writeReportOutbox, readReportOutbox, ReportOutboxEntry } from '../src/review/review-report-outbox';

describe('crash durability', () => {
  let dir: string;
  let originalCwd: string;
  beforeEach(() => {
    originalCwd = process.cwd();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durability-'));
    process.chdir(dir);
  });
  afterEach(() => { jest.restoreAllMocks(); process.chdir(originalCwd); fs.rmSync(dir, { recursive: true, force: true }); });

  it('syncs the state file before rename and the directory after rename', () => {
    const file = path.join(dir, 'state.json');
    const events: string[] = [];
    const sync = fs.fsyncSync.bind(fs);
    const rename = fs.renameSync.bind(fs);
    jest.spyOn(fs, 'fsyncSync').mockImplementation(fd => { events.push(fs.fstatSync(fd).isDirectory() ? 'dir sync' : 'file sync'); sync(fd); });
    jest.spyOn(fs, 'renameSync').mockImplementation((a, b) => { events.push('rename'); rename(a, b); });
    new ReviewedPRsState(file).markPRReviewed('a', 'b', 1, 'awaiting_human_review', 'sha');
    expect(events.slice(-3)).toEqual(['file sync', 'rename', 'dir sync']);
  });

  it('syncs parent directories when creating a new state directory', () => {
    const synced: number[] = [];
    const sync = fs.fsyncSync.bind(fs);
    jest.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      const stat = fs.fstatSync(fd);
      if (stat.isDirectory()) synced.push(stat.ino);
      sync(fd);
    });
    new ReviewedPRsState(path.join(dir, 'new', 'nested', 'state.json')).markPRReviewed('a', 'b', 1);
    expect(synced).toContain(fs.statSync(dir).ino);
    expect(synced).toContain(fs.statSync(path.join(dir, 'new')).ino);
  });

  it.each(['file', 'directory'])('propagates %s fsync failures rather than acknowledging a state commit', kind => {
    const file = path.join(dir, 'state.json');
    const sync = fs.fsyncSync.bind(fs);
    jest.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      const stat = fs.fstatSync(fd);
      if (kind === 'file' ? stat.isFile() : stat.isDirectory() && stat.ino === fs.statSync(dir).ino) throw new Error('sync failed');
      sync(fd);
    });
    expect(() => new ReviewedPRsState(file).markPRReviewed('a', 'b', 1, 'awaiting_human_review', 'sha')).toThrow('sync failed');
  });

  it('syncs outbox deletion and propagates directory sync failure even on retry after unlink', () => {
    const entry = { owner: 'a', repo: 'b', prNumber: 1, headSha: 'sha', status: 'published', details: null, draft: {} } as ReportOutboxEntry;
    writeReportOutbox(entry);
    const sync = fs.fsyncSync.bind(fs);
    const outboxInode = fs.statSync(path.join(dir, 'state', 'review-report-outbox')).ino;
    const spy = jest.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (fs.fstatSync(fd).ino === outboxInode) throw new Error('sync failed');
      sync(fd);
    });
    expect(() => deleteReportOutbox(entry)).toThrow('sync failed');
    expect(readReportOutbox('a', 'b', 1, 'sha')).toBeNull();
    expect(() => deleteReportOutbox(entry)).toThrow('sync failed');
    spy.mockRestore();
    const events: string[] = [];
    jest.spyOn(fs, 'fsyncSync').mockImplementation(fd => { events.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file'); sync(fd); });
    deleteReportOutbox(entry);
    expect(events[events.length - 1]).toBe('directory');
  });
});
