import { runReviewVerificationGate } from '../src/review/review-verification-gate';

describe('runReviewVerificationGate', () => {
  const firstDraft = JSON.stringify({
    summary: '1차 후보',
    comments: [{
      path: 'src/a.ts', line: 10, side: 'RIGHT', severity: 'important', body: '처리되지 않은 오류가 있습니다.',
    }],
    replies: [],
  });
  const verifiedDraft = JSON.stringify({
    summary: '검증 통과: 실제 오류 처리 누락',
    comments: [{
      path: 'src/a.ts', line: 10, side: 'RIGHT', severity: 'important', body: '처리되지 않은 오류가 있습니다.',
    }],
    replies: [],
  });

  it('runs a fresh verification pass and publishes only the verified output', async () => {
    const spawn = jest.fn()
      .mockResolvedValueOnce(firstDraft)
      .mockResolvedValueOnce(verifiedDraft);
    const publish = jest.fn().mockResolvedValue(undefined);

    const result = await runReviewVerificationGate({
      owner: 'org', repo: 'repo', prNumber: 123, clonePath: '/tmp/repo',
      spawn,
      publish,
    });

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0][0]).toContain('후보 초안만 작성');
    expect(spawn.mock.calls[1][0]).toContain('독립 검증자');
    expect(spawn.mock.calls[1][0]).toContain('처리되지 않은 오류가 있습니다.');
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ summary: '검증 통과: 실제 오류 처리 누락' }));
    expect(result.summary).toBe('검증 통과: 실제 오류 처리 누락');
  });

  it('does not publish when the independent verifier returns an invalid payload', async () => {
    const spawn = jest.fn()
      .mockResolvedValueOnce(firstDraft)
      .mockResolvedValueOnce('{"summary":"broken","comments":[],"replies":"not-array"}');
    const publish = jest.fn().mockResolvedValue(undefined);

    await expect(runReviewVerificationGate({
      owner: 'org', repo: 'repo', prNumber: 123, spawn, publish,
    })).rejects.toThrow('invalid review draft');

    expect(publish).not.toHaveBeenCalled();
  });
});
