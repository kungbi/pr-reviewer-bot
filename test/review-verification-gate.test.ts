import { runReviewVerificationGate } from '../src/review/review-verification-gate';

describe('runReviewVerificationGate', () => {
  const firstDraft = JSON.stringify({
    summary: '1차 후보',
    comments: [{
      path: 'src/a.ts', line: 10, side: 'RIGHT', severity: 'important', body: '처리되지 않은 오류가 있습니다.',
    }],
    replies: [],
  });
  const ponytailNoFindings = JSON.stringify({
    summary: 'Lean already. Ship.',
    comments: [],
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
      .mockResolvedValueOnce(ponytailNoFindings)
      .mockResolvedValueOnce(verifiedDraft);
    const publish = jest.fn().mockResolvedValue(undefined);

    const result = await runReviewVerificationGate({
      owner: 'org', repo: 'repo', prNumber: 123, clonePath: '/tmp/repo',
      spawn,
      publish,
    });

    expect(spawn).toHaveBeenCalledTimes(3);
    expect(spawn.mock.calls[0][0]).toContain('후보 초안만 작성');
    expect(spawn.mock.calls[1][0]).toContain('Ponytail');
    expect(spawn.mock.calls[2][0]).toContain('독립 검증자');
    expect(spawn.mock.calls[2][0]).toContain('처리되지 않은 오류가 있습니다.');
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ summary: '검증 통과: 실제 오류 처리 누락' }));
    expect(result.summary).toBe('검증 통과: 실제 오류 처리 누락');
  });

  it('runs Ponytail separately, merges its Minor candidates, then sends the combined draft to verification', async () => {
    const ponytailDraft = JSON.stringify({
      summary: 'net: -8 lines possible.',
      comments: [{
        path: 'src/b.ts', line: 4, side: 'RIGHT', severity: 'minor', body: 'yagni: 계층 하나. 직접 호출로 대체.',
      }],
      replies: [],
    });
    const verifiedCombined = JSON.stringify({
      summary: '검증 통과',
      comments: [
        { path: 'src/a.ts', line: 10, side: 'RIGHT', severity: 'important', body: '처리되지 않은 오류가 있습니다.' },
        { path: 'src/b.ts', line: 4, side: 'RIGHT', severity: 'minor', body: 'yagni: 계층 하나. 직접 호출로 대체.' },
      ],
      replies: [],
    });
    const spawn = jest.fn()
      .mockResolvedValueOnce(firstDraft)
      .mockResolvedValueOnce(ponytailDraft)
      .mockResolvedValueOnce(verifiedCombined);
    const publish = jest.fn().mockResolvedValue(undefined);

    await runReviewVerificationGate({
      owner: 'org', repo: 'repo', prNumber: 123, clonePath: '/tmp/repo', spawn, publish,
    });

    expect(spawn).toHaveBeenCalledTimes(3);
    expect(spawn.mock.calls[0][0]).toContain('1차 코드 리뷰어');
    expect(spawn.mock.calls[1][0]).toContain('Ponytail');
    expect(spawn.mock.calls[2][0]).toContain('처리되지 않은 오류가 있습니다.');
    expect(spawn.mock.calls[2][0]).toContain('yagni: 계층 하나. 직접 호출로 대체.');
  });

  it('does not publish when the independent verifier returns an invalid payload', async () => {
    const spawn = jest.fn()
      .mockResolvedValueOnce(firstDraft)
      .mockResolvedValueOnce(ponytailNoFindings)
      .mockResolvedValueOnce('{"summary":"broken","comments":[],"replies":"not-array"}');
    const publish = jest.fn().mockResolvedValue(undefined);

    await expect(runReviewVerificationGate({
      owner: 'org', repo: 'repo', prNumber: 123, spawn, publish,
    })).rejects.toThrow('invalid review draft');

    expect(publish).not.toHaveBeenCalled();
  });
});
