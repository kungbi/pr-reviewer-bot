import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';
import {
  ReviewComment,
  ReviewLesson,
  ReviewMemoryFile,
  ReviewMemoryQuery,
  ReviewThreadArchiveEntry,
} from '../types';

export const REVIEW_MEMORY_FILE = path.join(__dirname, '../../../state/review-memory.json');

const DEFAULT_MAX_TEXT_CHARS = 4000;

interface ReviewMemoryStoreOptions {
  maxTextChars?: number;
}

export interface ArchiveThreadInput {
  owner: string;
  repo: string;
  prNumber: number;
  parentComment: ReviewComment;
  humanReply: ReviewComment;
  botReplyBody?: string;
  botReplyUrl?: string;
}

export interface PruneReviewMemoryResult {
  threadsRemoved: number;
  lessonsArchived: number;
}

function emptyMemoryFile(): ReviewMemoryFile {
  return { version: 1, threads: {}, lessons: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isReviewMemoryFile(value: unknown): value is ReviewMemoryFile {
  return isRecord(value) && value.version === 1 && isRecord(value.threads) && isRecord(value.lessons);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(glob: string): RegExp {
  const escaped = escapeRegExp(glob)
    .replace(/\\\*\\\*\//g, '(?:.*/)?')
    .replace(/\\\*\\\*/g, '.*')
    .replace(/\\\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

function matchesAnyGlob(filePath: string, globs: string[] | undefined): boolean {
  if (!globs || globs.length === 0) return false;
  return globs.some((glob) => globToRegExp(glob).test(filePath));
}

function timestampMs(value: string | undefined): number {
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

export class ReviewMemoryStore {
  filePath: string;
  data: ReviewMemoryFile;
  private maxTextChars: number;

  constructor(filePath = REVIEW_MEMORY_FILE, options: ReviewMemoryStoreOptions = {}) {
    this.filePath = filePath;
    this.maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
    this.data = emptyMemoryFile();
  }

  load(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.data = emptyMemoryFile();
        return;
      }
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown;
      if (!isReviewMemoryFile(parsed)) {
        logger.warn('[ReviewMemoryStore] Memory file has unexpected format, resetting to defaults');
        this.data = emptyMemoryFile();
        return;
      }
      this.data = parsed;
    } catch (err) {
      logger.warn(`[ReviewMemoryStore] Failed to load review memory: ${(err as Error).message}`);
      this.data = emptyMemoryFile();
    }
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempFilePath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempFilePath, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tempFilePath, this.filePath);
  }

  getThreadId(owner: string, repo: string, prNumber: number, parentCommentId: number, humanReplyId: number): string {
    return `${owner}/${repo}#${prNumber}:${parentCommentId}:${humanReplyId}`;
  }

  archiveThread(input: ArchiveThreadInput): ReviewThreadArchiveEntry {
    const id = this.getThreadId(
      input.owner,
      input.repo,
      input.prNumber,
      input.parentComment.id,
      input.humanReply.id,
    );
    const existing = this.data.threads[id];
    const now = new Date().toISOString();
    const createdAt = input.humanReply.created_at ?? input.parentComment.created_at ?? existing?.createdAt ?? now;
    const entry: ReviewThreadArchiveEntry = {
      ...existing,
      id,
      owner: input.owner,
      repo: input.repo,
      prNumber: input.prNumber,
      parentCommentId: input.parentComment.id,
      humanReplyId: input.humanReply.id,
      parentCommentBody: this.truncateText(input.parentComment.body),
      humanReplyBody: this.truncateText(input.humanReply.body),
      path: input.parentComment.path ?? null,
      line: input.parentComment.line ?? input.parentComment.original_line ?? null,
      diffHunk: input.parentComment.diff_hunk ? this.truncateText(input.parentComment.diff_hunk) : null,
      parentCommentUrl: input.parentComment.html_url,
      humanReplyUrl: input.humanReply.html_url,
      botReplyBody: input.botReplyBody ? this.truncateText(input.botReplyBody) : existing?.botReplyBody,
      botReplyUrl: input.botReplyUrl ?? existing?.botReplyUrl,
      createdAt,
      updatedAt: now,
    };
    this.data.threads[id] = entry;
    this.save();
    return entry;
  }

  updateThreadClassification(
    threadId: string,
    patch: Pick<ReviewThreadArchiveEntry, 'classification' | 'classifierReason' | 'confidence'>,
  ): void {
    const existing = this.data.threads[threadId];
    if (!existing) return;
    this.data.threads[threadId] = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.save();
  }

  upsertLesson(lesson: ReviewLesson): ReviewLesson {
    const existing = this.data.lessons[lesson.id];
    const merged: ReviewLesson = existing
      ? {
          ...existing,
          ...lesson,
          confidence: Math.max(existing.confidence, lesson.confidence),
          createdAt: existing.createdAt,
          updatedAt: new Date().toISOString(),
        }
      : lesson;
    this.data.lessons[lesson.id] = merged;
    this.save();
    return merged;
  }

  getRelevantLessons(query: ReviewMemoryQuery): ReviewLesson[] {
    const limit = query.limit ?? 8;
    const pathHints = query.pathHints ?? [];
    return Object.values(this.data.lessons)
      .filter((lesson) => lesson.owner === query.owner && lesson.repo === query.repo && lesson.status === 'active')
      .sort((a, b) => {
        const aPathScore = this.pathMatchScore(a, pathHints);
        const bPathScore = this.pathMatchScore(b, pathHints);
        if (aPathScore !== bPathScore) return bPathScore - aPathScore;
        const aCategoryScore = a.category === 'false_positive' ? 1 : 0;
        const bCategoryScore = b.category === 'false_positive' ? 1 : 0;
        if (aCategoryScore !== bCategoryScore) return bCategoryScore - aCategoryScore;
        if (a.confidence !== b.confidence) return b.confidence - a.confidence;
        return timestampMs(b.updatedAt) - timestampMs(a.updatedAt);
      })
      .slice(0, limit);
  }

  pruneOldEntries(maxAgeMs: number, now = new Date()): PruneReviewMemoryResult {
    const cutoff = now.getTime() - maxAgeMs;
    let threadsRemoved = 0;
    for (const key of Object.keys(this.data.threads)) {
      const entry = this.data.threads[key];
      const entryMs = timestampMs(entry.createdAt || entry.updatedAt);
      if (!entryMs || entryMs < cutoff) {
        delete this.data.threads[key];
        threadsRemoved += 1;
      }
    }

    let lessonsArchived = 0;
    for (const key of Object.keys(this.data.lessons)) {
      const lesson = this.data.lessons[key];
      if (lesson.status !== 'active') continue;
      // Active lessons are durable team knowledge; retention only prunes raw archives in v1.
      void lesson;
    }

    if (threadsRemoved > 0 || lessonsArchived > 0) {
      this.save();
      logger.info(`[ReviewMemoryStore] Pruned review memory: threads=${threadsRemoved}, lessonsArchived=${lessonsArchived}`);
    }
    return { threadsRemoved, lessonsArchived };
  }

  private truncateText(value: string | undefined | null): string {
    const text = value ?? '';
    if (text.length <= this.maxTextChars) return text;
    return `${text.slice(0, this.maxTextChars)}\n...[truncated]`;
  }

  private pathMatchScore(lesson: ReviewLesson, pathHints: string[]): number {
    if (pathHints.length === 0) return 0;
    const globMatch = pathHints.some((hint) => matchesAnyGlob(hint, lesson.pathGlobs));
    if (globMatch) return 2;
    const sourcePath = lesson.source.path;
    if (sourcePath && pathHints.includes(sourcePath)) return 1;
    return 0;
  }
}

let sharedStore: ReviewMemoryStore | null = null;

export function getSharedReviewMemoryStore(): ReviewMemoryStore {
  if (!sharedStore) {
    const rawMaxChars = Number.parseInt(process.env.REVIEW_MEMORY_RAW_MAX_CHARS ?? '4000', 10);
    sharedStore = new ReviewMemoryStore(REVIEW_MEMORY_FILE, {
      maxTextChars: Number.isFinite(rawMaxChars) && rawMaxChars >= 100 ? rawMaxChars : 4000,
    });
    sharedStore.load();
  }
  return sharedStore;
}
