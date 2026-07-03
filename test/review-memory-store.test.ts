import fs from 'fs';
import os from 'os';
import path from 'path';
import { ReviewMemoryStore } from '../src/review-memory/review-memory-store';
import { ReviewComment, ReviewLesson } from '../src/types';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'review-memory-store-'));
}

function comment(overrides: Partial<ReviewComment>): ReviewComment {
  return {
    id: 1,
    body: 'body',
    user: { login: 'someone' },
    path: 'src/file.ts',
    line: 10,
    diff_hunk: '@@ hunk',
    html_url: 'https://example.com/comment',
    created_at: '2026-07-03T00:00:00.000Z',
    updated_at: '2026-07-03T00:00:00.000Z',
    ...overrides,
  };
}

function lesson(overrides: Partial<ReviewLesson> = {}): ReviewLesson {
  const now = '2026-07-03T00:00:00.000Z';
  return {
    id: 'owner/repo:project_convention:service-boundary',
    owner: 'owner',
    repo: 'repo',
    status: 'active',
    category: 'project_convention',
    confidence: 0.9,
    title: 'Service boundary',
    lesson: 'Keep validation at controller boundary and orchestration in service.',
    whenToApply: ['service create/update flows'],
    doNotApply: ['test fixtures'],
    pathGlobs: ['src/**/*.service.ts'],
    tags: ['service', 'validation'],
    source: {
      owner: 'owner',
      repo: 'repo',
      prNumber: 1,
      parentCommentId: 100,
      humanReplyId: 101,
      path: 'src/service.ts',
      line: 42,
      createdAt: now,
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('ReviewMemoryStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = tmpDir();
    filePath = path.join(dir, 'nested', 'review-memory.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('loads an empty versioned memory file when no file exists', () => {
    const store = new ReviewMemoryStore(filePath);
    store.load();

    expect(store.data).toEqual({ version: 1, threads: {}, lessons: {} });
  });

  it('archives a review thread with truncated raw text', () => {
    const store = new ReviewMemoryStore(filePath, { maxTextChars: 12 });
    store.load();

    const parent = comment({ id: 100, user: { login: 'bot' }, body: 'x'.repeat(40), diff_hunk: 'y'.repeat(40) });
    const humanReply = comment({ id: 101, in_reply_to_id: 100, user: { login: 'human' }, body: 'z'.repeat(40) });

    const archived = store.archiveThread({
      owner: 'owner',
      repo: 'repo',
      prNumber: 1,
      parentComment: parent,
      humanReply,
      botReplyBody: 'bot reply body',
      botReplyUrl: 'https://example.com/bot-reply',
    });

    expect(archived.id).toBe('owner/repo#1:100:101');
    expect(archived.parentCommentBody).toContain('[truncated]');
    expect(archived.humanReplyBody).toContain('[truncated]');
    expect(archived.diffHunk).toContain('[truncated]');
    expect(archived.botReplyUrl).toBe('https://example.com/bot-reply');

    const reloaded = new ReviewMemoryStore(filePath);
    reloaded.load();
    expect(Object.keys(reloaded.data.threads)).toEqual(['owner/repo#1:100:101']);
  });

  it('upserts lessons and retrieves only active same-repo lessons', () => {
    const store = new ReviewMemoryStore(filePath);
    store.load();

    store.upsertLesson(lesson());
    store.upsertLesson(lesson({ id: 'owner/other:project_convention:x', repo: 'other' }));
    store.upsertLesson(lesson({ id: 'owner/repo:project_convention:archived', status: 'archived', title: 'Archived' }));

    const lessons = store.getRelevantLessons({ owner: 'owner', repo: 'repo', pathHints: ['src/foo.service.ts'], limit: 5 });

    expect(lessons.map((item) => item.id)).toEqual(['owner/repo:project_convention:service-boundary']);
  });

  it('ranks path-matching and higher-confidence lessons first', () => {
    const store = new ReviewMemoryStore(filePath);
    store.load();

    store.upsertLesson(lesson({
      id: 'owner/repo:project_convention:generic',
      title: 'Generic',
      confidence: 0.99,
      pathGlobs: ['docs/**/*.md'],
    }));
    store.upsertLesson(lesson({
      id: 'owner/repo:project_convention:service',
      category: 'project_convention',
      title: 'Service convention',
      confidence: 0.8,
      pathGlobs: ['src/**/*.service.ts'],
    }));

    const lessons = store.getRelevantLessons({ owner: 'owner', repo: 'repo', pathHints: ['src/foo.service.ts'], limit: 2 });

    expect(lessons[0].id).toBe('owner/repo:project_convention:service');
  });

  it('prunes old raw thread archives but keeps active lessons', () => {
    const store = new ReviewMemoryStore(filePath);
    store.load();

    const oldParent = comment({ id: 100, user: { login: 'bot' }, created_at: '2025-01-01T00:00:00.000Z' });
    const oldReply = comment({ id: 101, in_reply_to_id: 100, created_at: '2025-01-01T00:00:00.000Z' });
    store.archiveThread({ owner: 'owner', repo: 'repo', prNumber: 1, parentComment: oldParent, humanReply: oldReply });
    store.upsertLesson(lesson());

    const result = store.pruneOldEntries(30 * 24 * 60 * 60 * 1000, new Date('2026-07-03T00:00:00.000Z'));

    expect(result.threadsRemoved).toBe(1);
    expect(Object.keys(store.data.threads)).toHaveLength(0);
    expect(Object.keys(store.data.lessons)).toHaveLength(1);
  });
});
