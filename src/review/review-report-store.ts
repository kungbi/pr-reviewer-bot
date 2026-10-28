import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runtimeStatePath } from '../utils/runtime-paths';

const MAX_REPORT_BYTES = 2_000_000;
const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const FULL_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

export interface StoreReviewReportHtmlOptions {
  owner: string;
  repository: string;
  pullRequestNumber: number;
  headSha: string;
  html: string;
  /** Test seam; production uses <server-root>/state/review-reports. */
  reportRoot?: string;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function validateIdentity(options: StoreReviewReportHtmlOptions): void {
  if (
    !SAFE_SEGMENT.test(options.owner) || options.owner === '.' || options.owner === '..'
    || !SAFE_SEGMENT.test(options.repository) || options.repository === '.' || options.repository === '..'
    || !Number.isSafeInteger(options.pullRequestNumber) || options.pullRequestNumber < 1
    || !FULL_SHA.test(options.headSha)
  ) {
    throw new Error('invalid report artifact identity');
  }
}

export function createPrivateReportRoot(reportRoot: string): string {
  const resolved = path.resolve(reportRoot);
  if (!['review-reports', 'review-report-outbox'].includes(path.basename(resolved)) || path.basename(path.dirname(resolved)) !== 'state') {
    throw new Error('report root must be the server state/review-reports directory');
  }

  const parsed = path.parse(resolved);
  const components = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isNodeError(mkdirError) || mkdirError.code !== 'EEXIST') throw mkdirError;
      }
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink()) throw new Error('report path contains a symlink');
    if (!stat.isDirectory()) throw new Error('report path component is not a directory');
    // Existing components can be remnants of a failed creation sync; retry every
    // parent before acknowledging a durable outbox or report.
    const parent = fs.openSync(path.dirname(current), fs.constants.O_RDONLY);
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    if (index >= components.length - 2) fs.chmodSync(current, 0o700);
  }
  return resolved;
}

function optionalLstat(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Persist one private HTML report with a stable identity and an atomic replace. */
export function storeReviewReportHtml(options: StoreReviewReportHtmlOptions): string {
  validateIdentity(options);
  if (typeof options.html !== 'string' || options.html.length === 0) {
    throw new Error('report artifact must contain HTML');
  }
  if (Buffer.byteLength(options.html, 'utf8') > MAX_REPORT_BYTES) {
    throw new Error('report artifact exceeds the permitted size limit');
  }

  const root = createPrivateReportRoot(
    options.reportRoot ?? runtimeStatePath('review-reports'),
  );
  const filename = `${options.owner.toLowerCase()}__${options.repository.toLowerCase()}__${options.pullRequestNumber}__${options.headSha.toLowerCase()}.html`;
  const destination = path.join(root, filename);
  const relative = path.relative(root, destination);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('report artifact path escaped the private report root');
  }

  const existing = optionalLstat(destination);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error('report artifact destination must be a regular, non-symlink file');
  }

  const temporary = path.join(root, `.${filename}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(descriptor, options.html, 'utf8');
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;

    const beforeRename = optionalLstat(destination);
    if (beforeRename && (beforeRename.isSymbolicLink() || !beforeRename.isFile())) {
      throw new Error('report artifact destination changed to an unsafe file');
    }
    fs.renameSync(temporary, destination);
    const directory = fs.openSync(root, fs.constants.O_RDONLY);
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    return destination;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    }
  }
}
