import {
  buildReviewDraftPrompt, buildReviewVerificationPrompt, mergeReviewDrafts, parseVerifiedReviewDraft,
  prepareReviewForPosting, ReviewDraft,
} from '../src/review/review-draft';
import { runReviewVerificationGate } from '../src/review/review-verification-gate';
import { BOT_AUTHOR_DISCLOSURE } from '../src/utils/comment-disclosure';

const audit = '원본 comments/replies 후보 0건. GitHub GET 확인, 활성 thread 없음. 파일/GitHub 변경 없음. node_modules 없음.';
const publicSummary = {
  conclusion: '입력 검증 계약에 새 결함은 확인되지 않았습니다. 최종 판단은 사람이 해야 합니다.',
  evidence: ['빈 ID는 validateId에서 거부되며 호출자는 오류를 전파합니다.'],
  verificationLimits: ['연관 저장소는 다른 브랜치여서 배포 시 호환성은 확인하지 못했습니다.'],
};
const data = { summary: audit, publicSummary, comments: [], replies: [], existingFindings: [] };

describe('public review summary contract', () => {
  it('renders only public decision evidence, preserves material caveats and AI attribution', () => {
    const parsed = parseVerifiedReviewDraft(JSON.stringify(data));
    const posting = prepareReviewForPosting(parsed);
    expect(parsed.summary).toBe(audit);
    expect(posting.body).toContain(publicSummary.conclusion);
    expect(posting.body).toContain(publicSummary.evidence[0]);
    expect(posting.body).toContain(publicSummary.verificationLimits[0]);
    expect(posting.body).toContain('테스트 실행 결과 미확인');
    expect(posting.body).toContain(BOT_AUTHOR_DISCLOSURE);
    expect(posting.body).not.toContain('✅ **이슈 없음**');
    for (const noise of ['comments/replies', 'GitHub GET', '활성 thread 없음', '변경 없음', 'node_modules']) {
      expect(posting.body).not.toContain(noise);
    }
    expect(posting.event).toBe('COMMENT');
  });

  it.each([
    { ...publicSummary, conclusion: '' },
    { ...publicSummary, evidence: '문자열' },
    { ...publicSummary, evidence: [] },
    { ...publicSummary, verificationLimits: undefined },
    { ...publicSummary, evidence: Array(5).fill('근거') },
    { ...publicSummary, conclusion: '가'.repeat(601) },
    { ...publicSummary, hiddenAudit: audit },
  ])('rejects malformed public contract without deleting or rewriting uncertainty: %j', (invalid) => {
    expect(() => parseVerifiedReviewDraft(JSON.stringify({ ...data, publicSummary: invalid })))
      .toThrow(/publicSummary/);
  });

  it('requires a separate public summary at the real verification gate before publish', async () => {
    const legacy = JSON.stringify({ summary: audit, comments: [], replies: [] });
    const publish = jest.fn();
    await expect(runReviewVerificationGate({ owner: 'org', repo: 'repo', prNumber: 1,
      spawn: jest.fn().mockResolvedValue(legacy), publish,
    })).rejects.toThrow(/publicSummary/);
    expect(publish).not.toHaveBeenCalled();
  });

  it('carries verified public summary through the real gate without leaking audit', async () => {
    const spawn = jest.fn().mockResolvedValueOnce(JSON.stringify(data))
      .mockResolvedValueOnce(JSON.stringify({ summary: 'recall', comments: [], replies: [] }))
      .mockResolvedValueOnce(JSON.stringify({ summary: 'Lean already. Ship.', comments: [], replies: [] }))
      .mockResolvedValueOnce(JSON.stringify(data));
    const publish = jest.fn();
    const verified = await runReviewVerificationGate({ owner: 'org', repo: 'repo', prNumber: 1, spawn, publish });
    expect(spawn.mock.calls[3][0]).toContain(publicSummary.verificationLimits[0]);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ publicSummary }));
    expect(prepareReviewForPosting(verified).body).not.toContain(audit);
  });

  it('keeps primary public caveats across specialist merging without promoting specialist audit prose', () => {
    const merged = mergeReviewDrafts(data, { summary: 'net: -10 lines possible.', publicSummary: {
      conclusion: 'Lean already. Ship.', evidence: ['internal specialist metrics'], verificationLimits: [],
    }, comments: [], replies: [] });
    expect(merged.publicSummary).toEqual(publicSummary);
    expect(prepareReviewForPosting(merged).body).not.toContain('Ship.');
  });

  it('keeps legacy durable payloads byte-compatible instead of changing ambiguous write identity', () => {
    const legacy: ReviewDraft = { summary: audit, comments: [], replies: [] };
    expect(prepareReviewForPosting(legacy).body).toContain(audit);
  });

  it('instructs draft and independent verifier to separate public copy from private provenance', () => {
    const params = { owner: 'org', repo: 'repo', prNumber: 1 };
    for (const prompt of [buildReviewDraftPrompt(params), buildReviewVerificationPrompt({ ...params, candidate: data })]) {
      for (const token of ['publicSummary', 'conclusion', 'evidence', 'verificationLimits', '비공개 HTML', 'node_modules', '격리 테스트 러너', '브랜치']) {
        expect(prompt).toContain(token);
      }
      expect(prompt).toContain('후보 수');
      expect(prompt).toContain('자기 서술');
    }
  });
});
