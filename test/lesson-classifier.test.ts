import { normalizeLessonCandidate } from '../src/review-memory/lesson-classifier';

describe('normalizeLessonCandidate', () => {
  it('accepts high-confidence project conventions as persistable lessons', () => {
    const candidate = normalizeLessonCandidate({
      category: 'project_convention',
      confidence: 0.91,
      title: 'Transaction boundary',
      lesson: 'Do not call external APIs inside DB transactions in this repo.',
      whenToApply: ['transactional create/update flows'],
      doNotApply: ['read-only queries'],
      pathGlobs: ['src/**/*.service.ts'],
      tags: ['transaction', 'side-effect'],
      reason: 'Human stated this is the repo convention.',
    });

    expect(candidate.category).toBe('project_convention');
    expect(candidate.shouldPersistLesson).toBe(true);
    expect(candidate.confidence).toBe(0.91);
    expect(candidate.whenToApply).toEqual(['transactional create/update flows']);
  });

  it('keeps known false positives as persistable high-priority lessons', () => {
    const candidate = normalizeLessonCandidate({
      category: 'false_positive',
      confidence: 0.86,
      title: 'ValidationPipe covers query defaults',
      lesson: 'Do not flag missing service-level validation when this controller path uses DTO + global ValidationPipe.',
    });

    expect(candidate.category).toBe('false_positive');
    expect(candidate.shouldPersistLesson).toBe(true);
    expect(candidate.doNotApply).toEqual([]);
  });

  it('does not persist low-confidence or incomplete candidates', () => {
    expect(normalizeLessonCandidate({ category: 'project_convention', confidence: 0.4, title: 'Maybe', lesson: 'Maybe.' }).shouldPersistLesson).toBe(false);
    expect(normalizeLessonCandidate({ category: 'accepted', confidence: 0.9, title: 'Missing lesson' }).shouldPersistLesson).toBe(false);
  });

  it('treats acknowledgements and invalid values as unresolved', () => {
    expect(normalizeLessonCandidate(null).category).toBe('unresolved');
    expect(normalizeLessonCandidate({ category: 'thanks', confidence: 1 }).category).toBe('unresolved');
    expect(normalizeLessonCandidate({ category: 'unresolved', confidence: 0.9 }).shouldPersistLesson).toBe(false);
  });

  it('persists one-off exceptions only as cautionary lessons', () => {
    const candidate = normalizeLessonCandidate({
      category: 'one_off_exception',
      confidence: 0.8,
      title: 'Legacy wrapper exception',
      lesson: 'This PR intentionally keeps a legacy wrapper shape for compatibility.',
    });

    expect(candidate.shouldPersistLesson).toBe(true);
    expect(candidate.category).toBe('one_off_exception');
  });
});
