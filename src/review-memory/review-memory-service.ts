import config from '../utils/config';
import logger from '../utils/logger';
import {
  ReviewComment,
  ReviewLesson,
  ReviewMemoryContext,
  ReviewMemorySource,
} from '../types';
import {
  ArchiveThreadInput,
  getSharedReviewMemoryStore,
  ReviewMemoryStore,
} from './review-memory-store';
import { loadOrganizationReviewWiki } from './organization-review-wiki';
import {
  classifyReviewThread,
  ClassifyReviewThreadInput,
  LessonCandidate,
} from './lesson-classifier';

export interface ArchiveAndLearnInput extends ArchiveThreadInput {}

export interface ArchiveAndLearnOptions {
  store?: ReviewMemoryStore;
  memoryEnabled?: boolean;
  classify?: (input: ClassifyReviewThreadInput) => Promise<LessonCandidate>;
  now?: () => Date;
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'lesson';
}

function buildSource(input: ArchiveAndLearnInput, createdAt: string): ReviewMemorySource {
  return {
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    parentCommentId: input.parentComment.id,
    humanReplyId: input.humanReply.id,
    parentCommentUrl: input.parentComment.html_url,
    humanReplyUrl: input.humanReply.html_url,
    path: input.parentComment.path ?? null,
    line: input.parentComment.line ?? input.parentComment.original_line ?? null,
    createdAt,
  };
}

function isTrivialAcknowledgement(body: string): boolean {
  const normalized = body.trim().toLowerCase().replace(/[\s.!?~。]+/g, '');
  if (!normalized) return false;
  return [
    'thanks',
    'thankyou',
    '감사합니다',
    '감사해요',
    '확인했습니다',
    '확인했어요',
    '넵',
    '네',
    'ok',
    'okay',
    '👍',
  ].includes(normalized);
}

function candidateToLesson(input: ArchiveAndLearnInput, candidate: LessonCandidate, now: Date): ReviewLesson {
  const timestamp = now.toISOString();
  const id = `${input.owner}/${input.repo}:${candidate.category}:${slugify(candidate.title)}`;
  return {
    id,
    owner: input.owner,
    repo: input.repo,
    status: 'active',
    category: candidate.category,
    confidence: candidate.confidence,
    title: candidate.title,
    lesson: candidate.lesson,
    whenToApply: candidate.whenToApply,
    doNotApply: candidate.doNotApply,
    pathGlobs: candidate.pathGlobs,
    tags: candidate.tags,
    source: buildSource(input, input.humanReply.created_at ?? timestamp),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function archiveAndMaybeLearnFromThread(
  input: ArchiveAndLearnInput,
  options: ArchiveAndLearnOptions = {},
): Promise<void> {
  const memoryEnabled = options.memoryEnabled ?? config.reviewMemoryEnabled;
  if (!memoryEnabled) {
    logger.debug(`[review-memory] Disabled; skipping raw archive and lesson classification for ${input.owner}/${input.repo}#${input.prNumber} comment ${input.humanReply.id}`);
    return;
  }

  const store = options.store ?? getSharedReviewMemoryStore();
  const classify = options.classify ?? classifyReviewThread;
  const now = options.now ?? (() => new Date());

  const archived = store.archiveThread(input);

  if (!input.botReplyBody && isTrivialAcknowledgement(input.humanReply.body)) {
    store.updateThreadClassification(archived.id, {
      classification: 'unresolved',
      confidence: 1,
      classifierReason: 'Trivial acknowledgement; classifier skipped.',
    });
    logger.info(`[review-memory] Archived ${archived.id}; classifier skipped for trivial acknowledgement`);
    return;
  }

  const candidate = await classify({
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    parentComment: input.parentComment,
    humanReply: input.humanReply,
    botReplyBody: input.botReplyBody,
  });

  store.updateThreadClassification(archived.id, {
    classification: candidate.category,
    confidence: candidate.confidence,
    classifierReason: candidate.reason,
  });

  if (!candidate.shouldPersistLesson) {
    logger.info(`[review-memory] Archived ${archived.id}; no durable lesson (${candidate.category}, confidence=${candidate.confidence})`);
    return;
  }

  const lesson = candidateToLesson(input, candidate, now());
  store.upsertLesson(lesson);
  logger.info(`[review-memory] Persisted lesson ${lesson.id} from ${archived.id}`);
}

export function getReviewMemoryContext(input: {
  owner: string;
  repo: string;
  pathHints?: string[];
  limit?: number;
  wikiDirectory?: string;
  store?: ReviewMemoryStore;
}): ReviewMemoryContext {
  if (!config.reviewMemoryEnabled) return { lessons: [] };
  const store = input.store ?? getSharedReviewMemoryStore();
  return {
    lessons: store.getRelevantLessons({
      owner: input.owner,
      repo: input.repo,
      pathHints: input.pathHints,
      limit: input.limit ?? config.reviewMemoryMaxLessons,
    }),
    organizationWiki: loadOrganizationReviewWiki({
      owner: input.owner,
      wikiDirectory: input.wikiDirectory,
    }),
  };
}

export type { ReviewComment };
