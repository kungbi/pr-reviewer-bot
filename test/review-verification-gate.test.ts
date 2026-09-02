import { runReviewVerificationGate } from '../src/review/review-verification-gate';
import * as verificationGateModule from '../src/review/review-verification-gate';
import { ModelCapacityError } from '../src/utils/sessions_spawn';

const runModelCapacityRetry = (verificationGateModule as typeof verificationGateModule & {
  runModelCapacityRetry: <T>(
    stage: string,
    invoke: () => Promise<T>,
    options?: { maxAttempts?: number; baseDelayMs?: number; random?: () => number; sleep?: (ms: number) => Promise<void> },
  ) => Promise<T>;
}).runModelCapacityRetry;

describe('runReviewVerificationGate', () => {
  const firstDraft = JSON.stringify({
    summary: '1차 후보',
    comments: [{
      path: 'src/a.ts', line: 10, side: 'RIGHT', severity: 'important', kind: 'finding', body: '처리되지 않은 오류가 있습니다.',
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
      path: 'src/a.ts', line: 10, side: 'RIGHT', severity: 'important', kind: 'finding', body: '처리되지 않은 오류가 있습니다.',
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
        path: 'src/b.ts', line: 4, side: 'RIGHT', severity: 'minor', kind: 'proposal', body: 'yagni: 계층 하나. 직접 호출로 대체.', proposal: { proposal: '계층을 제거하고 직접 호출합니다.', benefit: '계층 하나를 줄입니다.', risk: '타입 경계가 약해집니다.', convention: '유사 패턴이 없습니다.', scope: 'current_pr' },
      }],
      replies: [],
    });
    const verifiedCombined = JSON.stringify({
      summary: '검증 통과',
      comments: [
        { path: 'src/a.ts', line: 10, side: 'RIGHT', severity: 'important', kind: 'finding', body: '처리되지 않은 오류가 있습니다.' },
        { path: 'src/b.ts', line: 4, side: 'RIGHT', severity: 'minor', kind: 'proposal', body: 'yagni: 계층 하나. 직접 호출로 대체.', proposal: { proposal: '계층을 제거하고 직접 호출합니다.', benefit: '계층 하나를 줄입니다.', risk: '타입 경계가 약해집니다.', convention: '유사 패턴이 없습니다.', scope: 'current_pr' } },
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

  it('does not publish when verification reclassifies a normal proposal as a finding', async () => {
    const proposalDraft = JSON.stringify({
      summary: '구조 개선 후보',
      comments: [{
        path: 'src/adapter.ts', line: 21, side: 'RIGHT', severity: 'minor', kind: 'proposal',
        body: '중간 위임 계층을 직접 호출로 바꾸는 선택지입니다.',
        proposal: {
          proposal: '중간 위임 계층을 제거하고 직접 호출합니다.',
          benefit: '현재 경로의 중복 위임을 줄입니다.',
          risk: '타입 경계와 레포 컨벤션이 약해질 수 있습니다.',
          convention: '유사 계층과 테스트 계약을 비교해야 합니다.',
          scope: 'follow_up',
        },
      }],
      replies: [],
    });
    const reclassified = JSON.stringify({
      summary: '검증 통과',
      comments: [{
        path: 'src/adapter.ts', line: 21, side: 'RIGHT', severity: 'minor', kind: 'finding',
        body: '중간 위임 계층을 직접 호출로 바꾸는 선택지입니다.',
      }],
      replies: [],
    });
    const spawn = jest.fn()
      .mockResolvedValueOnce(proposalDraft)
      .mockResolvedValueOnce(ponytailNoFindings)
      .mockResolvedValueOnce(reclassified);
    const publish = jest.fn().mockResolvedValue(undefined);

    await expect(runReviewVerificationGate({
      owner: 'org', repo: 'repo', prNumber: 123, clonePath: '/tmp/repo', spawn, publish,
    })).rejects.toThrow('verified comments must retain candidate kind, severity, and body');

    expect(publish).not.toHaveBeenCalled();
  });

  it('does not publish when verification downgrades a finding to a proposal', async () => {
    const downgraded = JSON.stringify({
      summary: '검증 통과',
      comments: [{
        path: 'src/a.ts', line: 10, side: 'RIGHT', severity: 'minor', kind: 'proposal',
        body: '처리되지 않은 오류가 있습니다.',
        proposal: {
          proposal: '오류 처리를 단순화합니다.',
          benefit: '분기 하나를 줄입니다.',
          risk: '실제 오류를 가릴 수 있습니다.',
          convention: '유사 구현을 비교해야 합니다.',
          scope: 'follow_up',
        },
      }],
      replies: [],
    });
    const spawn = jest.fn()
      .mockResolvedValueOnce(firstDraft)
      .mockResolvedValueOnce(ponytailNoFindings)
      .mockResolvedValueOnce(downgraded);
    const publish = jest.fn().mockResolvedValue(undefined);

    await expect(runReviewVerificationGate({
      owner: 'org', repo: 'repo', prNumber: 123, clonePath: '/tmp/repo', spawn, publish,
    })).rejects.toThrow('verified comments must retain candidate kind, severity, and body');

    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects a verifier that escalates a Ponytail candidate above Minor', async () => {
    const ponytailDraft = JSON.stringify({
      summary: 'net: -8 lines possible.',
      comments: [{
        path: 'src/b.ts', line: 4, side: 'RIGHT', severity: 'minor', kind: 'proposal', body: 'yagni: 계층 하나. 직접 호출로 대체.', proposal: { proposal: '계층을 제거하고 직접 호출합니다.', benefit: '계층 하나를 줄입니다.', risk: '타입 경계가 약해집니다.', convention: '유사 패턴이 없습니다.', scope: 'current_pr' },
      }],
      replies: [],
    });
    const escalated = JSON.stringify({
      summary: '검증 통과',
      comments: [
        { path: 'src/a.ts', line: 10, side: 'RIGHT', severity: 'important', kind: 'finding', body: '처리되지 않은 오류가 있습니다.' },
        { path: 'src/b.ts', line: 4, side: 'RIGHT', severity: 'important', kind: 'proposal', body: 'yagni: 계층 하나. 직접 호출로 대체.', proposal: { proposal: '계층을 제거하고 직접 호출합니다.', benefit: '계층 하나를 줄입니다.', risk: '타입 경계가 약해집니다.', convention: '유사 패턴이 없습니다.', scope: 'current_pr' } },
      ],
      replies: [],
    });
    const spawn = jest.fn()
      .mockResolvedValueOnce(firstDraft)
      .mockResolvedValueOnce(ponytailDraft)
      .mockResolvedValueOnce(escalated);
    const publish = jest.fn().mockResolvedValue(undefined);

    await expect(runReviewVerificationGate({
      owner: 'org', repo: 'repo', prNumber: 123, clonePath: '/tmp/repo', spawn, publish,
    })).rejects.toThrow('proposal comments must be minor');

    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects a verifier that removes a Ponytail tag', async () => {
    const ponytailDraft = JSON.stringify({
      summary: 'net: -8 lines possible.',
      comments: [{
        path: 'src/b.ts', line: 4, side: 'RIGHT', severity: 'minor', kind: 'proposal', body: 'yagni: 계층 하나. 직접 호출로 대체.', proposal: { proposal: '계층을 제거하고 직접 호출합니다.', benefit: '계층 하나를 줄입니다.', risk: '타입 경계가 약해집니다.', convention: '유사 패턴이 없습니다.', scope: 'current_pr' },
      }],
      replies: [],
    });
    const untagged = JSON.stringify({
      summary: '검증 통과',
      comments: [
        { path: 'src/a.ts', line: 10, side: 'RIGHT', severity: 'important', kind: 'finding', body: '처리되지 않은 오류가 있습니다.' },
        { path: 'src/b.ts', line: 4, side: 'RIGHT', severity: 'minor', kind: 'proposal', body: '계층 하나. 직접 호출로 대체.', proposal: { proposal: '계층을 제거하고 직접 호출합니다.', benefit: '계층 하나를 줄입니다.', risk: '타입 경계가 약해집니다.', convention: '유사 패턴이 없습니다.', scope: 'current_pr' } },
      ],
      replies: [],
    });
    const spawn = jest.fn()
      .mockResolvedValueOnce(firstDraft)
      .mockResolvedValueOnce(ponytailDraft)
      .mockResolvedValueOnce(untagged);
    const publish = jest.fn().mockResolvedValue(undefined);

    await expect(runReviewVerificationGate({
      owner: 'org', repo: 'repo', prNumber: 123, clonePath: '/tmp/repo', spawn, publish,
    })).rejects.toThrow('verified comments must retain candidate kind, severity, and body');

    expect(publish).not.toHaveBeenCalled();
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

describe('capacity recovery in review gate', () => {
  it('retries a failed Ponytail pass without rerunning the completed primary pass', async () => {
    const primary = JSON.stringify({ summary: 'primary', comments: [], replies: [] });
    const ponytail = JSON.stringify({ summary: 'lean', comments: [], replies: [] });
    const verified = JSON.stringify({ summary: 'verified', comments: [], replies: [] });
    const spawn = jest.fn()
      .mockResolvedValueOnce(primary)
      .mockRejectedValueOnce(new ModelCapacityError('temporary capacity'))
      .mockResolvedValueOnce(ponytail)
      .mockResolvedValueOnce(verified);
    const publish = jest.fn().mockResolvedValue(undefined);
    const sleep = jest.fn().mockResolvedValue(undefined);
    const args = {
      owner: 'org', repo: 'repo', prNumber: 123, clonePath: '/tmp/repo', spawn, publish,
      capacityRetry: { baseDelayMs: 0, random: () => 0, sleep },
    } as Parameters<typeof runReviewVerificationGate>[0] & {
      capacityRetry: { baseDelayMs: number; random: () => number; sleep: (ms: number) => Promise<void> };
    };

    await expect(runReviewVerificationGate(args)).resolves.toMatchObject({ summary: 'verified' });

    expect(spawn).toHaveBeenCalledTimes(4);
    expect(spawn.mock.calls[0][0]).toContain('1차 코드 리뷰어');
    expect(spawn.mock.calls[1][0]).toContain('Ponytail');
    expect(spawn.mock.calls[2][0]).toContain('Ponytail');
    expect(spawn.mock.calls[3][0]).toContain('독립 검증자');
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe('runModelCapacityRetry', () => {
  it('retries only the failed stage after a structured capacity error', async () => {
    const invoke = jest.fn()
      .mockRejectedValueOnce(new ModelCapacityError('temporary capacity'))
      .mockResolvedValueOnce('verified output');
    const sleep = jest.fn().mockResolvedValue(undefined);

    await expect(runModelCapacityRetry('verifier', invoke, {
      baseDelayMs: 100,
      random: () => 0,
      sleep,
    })).resolves.toBe('verified output');

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it('does not retry a semantic or malformed-output failure', async () => {
    const invoke = jest.fn().mockRejectedValue(new Error('invalid review draft'));
    const sleep = jest.fn().mockResolvedValue(undefined);

    await expect(runModelCapacityRetry('primary', invoke, { sleep })).rejects.toThrow('invalid review draft');

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
