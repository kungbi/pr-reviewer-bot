import fs from 'fs';
import os from 'os';
import path from 'path';
import { archiveAndMaybeLearnFromThread } from '../src/review-memory/review-memory-service';
import { ReviewMemoryStore } from '../src/review-memory/review-memory-store';
import { ReviewComment } from '../src/types';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'review-memory-service-'));
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

describe('archiveAndMaybeLearnFromThread', () => {
  let dir: string;
  let store: ReviewMemoryStore;

  beforeEach(() => {
    dir = tmpDir();
    store = new ReviewMemoryStore(path.join(dir, 'review-memory.json'));
    store.load();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('archives a thread and persists a high-confidence lesson', async () => {
    const parentComment = comment({ id: 100, user: { login: 'bot' }, body: 'Can we split transaction and external API call?' });
    const humanReply = comment({ id: 101, in_reply_to_id: 100, user: { login: 'human' }, body: '맞아요. 이 repo에서는 transaction 안에서 외부 API를 호출하지 않기로 했습니다.' });

    await archiveAndMaybeLearnFromThread({
      owner: 'owner',
      repo: 'repo',
      prNumber: 1,
      parentComment,
      humanReply,
    }, {
      store,
      memoryEnabled: true,
      classify: async () => ({
        category: 'project_convention',
        confidence: 0.92,
        title: 'Transaction boundary',
        lesson: 'Do not call external APIs inside DB transactions in this repo.',
        whenToApply: ['transactional create/update flows'],
        doNotApply: ['read-only queries'],
        pathGlobs: ['src/**/*.service.ts'],
        tags: ['transaction'],
        reason: 'Human confirmed repo convention.',
        shouldPersistLesson: true,
      }),
      now: () => new Date('2026-07-03T00:00:00.000Z'),
    });

    expect(Object.keys(store.data.threads)).toEqual(['owner/repo#1:100:101']);
    const lessons = store.getRelevantLessons({ owner: 'owner', repo: 'repo' });
    expect(lessons).toHaveLength(1);
    expect(lessons[0].id).toBe('owner/repo:project_convention:transaction-boundary');
  });

  it('archives trivial acknowledgements without calling the classifier', async () => {
    const classify = jest.fn();

    await archiveAndMaybeLearnFromThread({
      owner: 'owner',
      repo: 'repo',
      prNumber: 1,
      parentComment: comment({ id: 100, user: { login: 'bot' } }),
      humanReply: comment({ id: 101, in_reply_to_id: 100, body: '감사합니다!' }),
    }, {
      store,
      memoryEnabled: true,
      classify,
    });

    expect(classify).not.toHaveBeenCalled();
    expect(Object.keys(store.data.threads)).toHaveLength(1);
    expect(Object.values(store.data.threads)[0].classification).toBe('unresolved');
    expect(Object.keys(store.data.lessons)).toHaveLength(0);
  });

  it('does not archive or call classifier when memory is disabled', async () => {
    const classify = jest.fn();

    await archiveAndMaybeLearnFromThread({
      owner: 'owner',
      repo: 'repo',
      prNumber: 1,
      parentComment: comment({ id: 100, user: { login: 'bot' } }),
      humanReply: comment({ id: 101, in_reply_to_id: 100 }),
    }, { store, memoryEnabled: false, classify });

    expect(classify).not.toHaveBeenCalled();
    expect(Object.keys(store.data.threads)).toHaveLength(0);
    expect(Object.keys(store.data.lessons)).toHaveLength(0);
  });
});
