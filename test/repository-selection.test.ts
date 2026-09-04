import {
  buildRepositorySelectionPrompt,
  parseRepositorySelection,
  RepositoryCatalogEntry,
} from '../src/review/repository-selection';

const catalog: RepositoryCatalogEntry[] = [
  {
    owner: 'team',
    repo: 'api',
    fullName: 'team/api',
    description: 'Public API service',
    defaultBranch: 'main',
    path: '/cache/team/api',
  },
  {
    owner: 'team',
    repo: 'worker',
    fullName: 'team/worker',
    description: 'Consumes API events',
    defaultBranch: 'main',
    path: '/cache/team/worker',
  },
];

describe('repository context selection', () => {
  it('requires an initial repository decision before detailed review while allowing evidence-driven expansion', () => {
    const prompt = buildRepositorySelectionPrompt({
      owner: 'team',
      repo: 'api',
      prNumber: 42,
      clonePath: '/worktrees/team-api-42',
      baseBranch: 'main',
      catalog,
      catalogPath: '/cache/repositories.json',
    });

    expect(prompt).toContain('상세 코드 리뷰를 시작하기 전에');
    expect(prompt).toContain('team/api');
    expect(prompt).toContain('항상 포함');
    expect(prompt).toContain('초기 선택은 상한선이 아니다');
    expect(prompt).toContain('/cache/repositories.json');
    expect(prompt).toContain('GitHub에 게시하지 마라');
  });

  it('uses only known catalog paths and always includes the target PR workspace', () => {
    const selected = parseRepositorySelection(
      JSON.stringify({
        repositories: [
          { fullName: 'team/worker', reason: '이벤트 소비자 계약을 확인해야 합니다.' },
          { fullName: 'other/private', reason: '임의 경로를 열어야 합니다.' },
        ],
      }),
      catalog,
      {
        owner: 'team',
        repo: 'api',
        clonePath: '/worktrees/team-api-42',
        baseBranch: 'main',
      },
    );

    expect(selected.map((repo) => repo.fullName)).toEqual(['team/api', 'team/worker']);
    expect(selected[0]).toMatchObject({
      fullName: 'team/api',
      path: '/worktrees/team-api-42',
      target: true,
    });
    expect(selected[1]).toMatchObject({
      fullName: 'team/worker',
      path: '/cache/team/worker',
      target: false,
    });
    expect(selected.some((repo) => repo.fullName === 'other/private')).toBe(false);
  });

  it('rejects selector output that would exceed the total repository context limit', () => {
    const largeCatalog: RepositoryCatalogEntry[] = Array.from({ length: 13 }, (_, index) => ({
      owner: 'team',
      repo: `repo-${index}`,
      fullName: `team/repo-${index}`,
      description: null,
      defaultBranch: 'main',
      path: `/cache/team/repo-${index}`,
    }));
    const output = JSON.stringify({
      repositories: largeCatalog.slice(1).map((repo) => ({
        fullName: repo.fullName,
        reason: '관련 계약 확인',
      })),
    });

    expect(() => parseRepositorySelection(output, largeCatalog, {
      owner: 'team',
      repo: 'repo-0',
      clonePath: '/worktrees/repo-0',
      baseBranch: 'main',
    })).toThrow('at most 11 additional repositories');
  });

  it('rejects malformed selector output instead of allowing arbitrary filesystem context', () => {
    expect(() => parseRepositorySelection(
      '{"repositories":[{"fullName":"team/worker","reason":123}]}',
      catalog,
      {
        owner: 'team',
        repo: 'api',
        clonePath: '/worktrees/team-api-42',
        baseBranch: 'main',
      },
    )).toThrow('invalid repository selection');
  });
});
