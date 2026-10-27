import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PRDetails } from '../types';
import { ReviewDraft } from './review-draft';
import { createPrivateReportRoot } from './review-report-store';
import logger from '../utils/logger';
import { ReviewReport } from '../types/review-report.types';
import { normalizeReviewReport } from './review-report';

export class ReportPublicationAmbiguousError extends Error {
  constructor() { super('Review publication outcome is ambiguous; manual reconciliation required'); this.name = 'ReportPublicationAmbiguousError'; }
}

export class ReportRecoveryError extends Error {
  constructor(message: string) { super(message); this.name = 'ReportRecoveryError'; }
}

export interface ReportOutboxEntry {
  owner: string; repo: string; prNumber: number; headSha: string;
  details: PRDetails | null; draft: ReviewDraft;
  diff?: string;
  reportSnapshotVersion?: 1;
  reportSnapshot?: { version: 1; report: ReviewReport; digest: string };
  status: 'prepared' | 'published';
  // Absent on legacy records; only an explicit unattempted value proves no reply was written.
  publicationIntent?: 'unattempted' | 'attempted';
}

export function snapshotReport(entry: ReportOutboxEntry, report: ReviewReport): void {
  const normalized = normalizeReviewReport(report);
  const digest = createHash('sha256').update(JSON.stringify([entry.owner, entry.repo, entry.prNumber, entry.headSha, entry.details, entry.draft, entry.diff, normalized])).digest('hex');
  entry.reportSnapshotVersion = 1;
  entry.reportSnapshot = { version: 1, report: normalized, digest };
}

export function validateReportSnapshot(entry: ReportOutboxEntry): ReviewReport | undefined {
  if (!Object.prototype.hasOwnProperty.call(entry, 'reportSnapshotVersion') && !Object.prototype.hasOwnProperty.call(entry, 'reportSnapshot')) return undefined; // legacy
  if (entry.reportSnapshotVersion !== 1) throw new Error('invalid report snapshot version');
  const snapshot = entry.reportSnapshot;
  if (!snapshot || snapshot.version !== 1 || Object.keys(snapshot).sort().join(',') !== 'digest,report,version') throw new Error('invalid report snapshot');
  const report = normalizeReviewReport(snapshot.report);
  const m = report.metadata;
  if (!entry.details || m.owner !== entry.owner || m.repository !== entry.repo || m.pullRequestNumber !== entry.prNumber
    || m.headSha !== entry.headSha || m.baseSha !== entry.details.baseSha || m.headRef !== entry.details.headRefName
    || m.baseRef !== entry.details.baseRefName || m.title !== entry.details.title || !report.testRunner || typeof entry.diff !== 'string') throw new Error('report snapshot identity mismatch');
  const digest = createHash('sha256').update(JSON.stringify([entry.owner, entry.repo, entry.prNumber, entry.headSha, entry.details, entry.draft, entry.diff, report])).digest('hex');
  if (snapshot.digest !== digest) throw new Error('report snapshot integrity mismatch');
  return report;
}

function location(owner: string, repo: string, prNumber: number, headSha: string): string {
  const key = createHash('sha256').update(JSON.stringify([owner.toLowerCase(), repo.toLowerCase(), prNumber, headSha.toLowerCase()])).digest('hex');
  return path.join(process.cwd(), 'state', 'review-report-outbox', `${key}.json`);
}

// Enumeration is capped: never silently skip records when the directory grows too
// large. Sorting a bounded snapshot makes the durable cursor independent of OS
// directory order and resilient to insertions, removals and process restarts.
const MAX_DISCOVERY_ENTRIES = 10000;
export function listReportOutbox(limit = 1000, onError: (message: string) => void = message => logger.error(message)): ReportOutboxEntry[] {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid outbox discovery limit');
  const root = createPrivateReportRoot(path.join(process.cwd(), 'state', 'review-report-outbox'));
  const cursorFile = path.join(root, '.discovery-cursor');
  const dir = fs.opendirSync(root);
  const names: string[] = [];
  try {
    let item: fs.Dirent | null;
    let count = 0;
    while ((item = dir.readSync())) {
      if (++count > MAX_DISCOVERY_ENTRIES) throw new Error(`outbox discovery overflow (>${MAX_DISCOVERY_ENTRIES} directory entries); operator intervention required`);
      if (/^[a-f0-9]{64}\.json$/.test(item.name)) names.push(item.name);
    }
  } finally { dir.closeSync(); }
  names.sort();
  let cursor = '';
  try {
    const fd = fs.openSync(cursorFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 69 || (stat.mode & 0o077) !== 0) throw new Error('unsafe outbox discovery cursor');
      cursor = fs.readFileSync(fd, 'utf8');
      if (!/^[a-f0-9]{64}\.json$/.test(cursor)) throw new Error('invalid outbox discovery cursor');
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      onError(`outbox discovery cursor unreadable or unsafe: ${(error as Error).message}; restarting scan, operator intervention may be required`);
      cursor = '';
    }
  }
  if (!names.length) return [];
  const start = names.findIndex(name => name > cursor);
  const ordered = start < 0 ? names : names.slice(start).concat(names.slice(0, start));
  const page = ordered.slice(0, limit);
  const entries: ReportOutboxEntry[] = [];
  for (const name of page) {
    try {
      const fd = fs.openSync(path.join(root, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let entry: ReportOutboxEntry;
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 2_000_000 || (stat.mode & 0o077) !== 0) throw new Error('unsafe outbox file');
        entry = JSON.parse(fs.readFileSync(fd, 'utf8')) as ReportOutboxEntry;
      } finally { fs.closeSync(fd); }
      if (!entry || typeof entry.owner !== 'string' || typeof entry.repo !== 'string'
        || !/^[A-Za-z0-9_-]+$/.test(entry.owner) || !/^[A-Za-z0-9_.-]+$/.test(entry.repo)
        || entry.repo === '.' || entry.repo === '..' || !Number.isSafeInteger(entry.prNumber) || entry.prNumber < 1
        || typeof entry.headSha !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(entry.headSha)
        || !['prepared', 'published'].includes(entry.status) || !entry.draft
        || path.basename(location(entry.owner, entry.repo, entry.prNumber, entry.headSha)) !== name) throw new Error('invalid outbox entry');
      validateReportSnapshot(entry);
      entries.push(entry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; // concurrent deletion
      onError(`outbox discovery failed for ${name}: ${(error as Error).message}; operator intervention required`);
    }
  }
  // Commit only after the whole page has been read. A crash after this commit
  // may defer the page, but wraparound guarantees it is revisited.
  const temp = path.join(root, `.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, page[page.length - 1]); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, cursorFile);
    const rootFd = fs.openSync(root, fs.constants.O_RDONLY);
    try { fs.fsyncSync(rootFd); } finally { fs.closeSync(rootFd); }
  } catch (error) {
    onError(`outbox discovery cursor could not be persisted: ${(error as Error).message}; scan may repeat, operator intervention required`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return entries;
}

export function readReportOutbox(owner: string, repo: string, prNumber: number, headSha: string): ReportOutboxEntry | null {
  const file = location(owner, repo, prNumber, headSha);
  try {
    // Validate every path component before opening; never follow a substituted file symlink.
    const root = createPrivateReportRoot(path.dirname(file));
    const fd = fs.openSync(path.join(root, path.basename(file)), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 2_000_000 || (stat.mode & 0o077) !== 0) throw new Error('unsafe report outbox file');
      const entry = JSON.parse(fs.readFileSync(fd, 'utf8')) as ReportOutboxEntry;
      if (entry.owner !== owner || entry.repo !== repo || entry.prNumber !== prNumber || entry.headSha !== headSha || !['prepared', 'published'].includes(entry.status) || !entry.draft) throw new Error('invalid report outbox entry');
      validateReportSnapshot(entry);
      return entry;
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function writeReportOutbox(entry: ReportOutboxEntry): void {
  validateReportSnapshot(entry);
  const file = location(entry.owner, entry.repo, entry.prNumber, entry.headSha);
  const root = createPrivateReportRoot(path.dirname(file));
  const temp = path.join(root, `.${randomUUID()}.tmp`);
  const data = JSON.stringify(entry);
  if (Buffer.byteLength(data) > 2_000_000) throw new Error('report outbox exceeds size limit');
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, data); fs.fchmodSync(fd, 0o600); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    const dir = fs.openSync(root, fs.constants.O_RDONLY); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
}

export function deleteReportOutbox(entry: ReportOutboxEntry): void {
  const file = location(entry.owner, entry.repo, entry.prNumber, entry.headSha);
  const root = createPrivateReportRoot(path.dirname(file));
  try { fs.unlinkSync(path.join(root, path.basename(file))); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  // Sync even on ENOENT: a previous unlink may have succeeded but its sync failed.
  const dir = fs.openSync(root, fs.constants.O_RDONLY);
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
