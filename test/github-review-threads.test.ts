import axios from 'axios';

jest.mock('axios');
jest.mock('../src/utils/config', () => ({ __esModule: true, default: { botName: 'review-thread-test' } }));
const mockedAxios = axios as jest.Mocked<typeof axios>;
const listReviewThreads = (require('../src/github') as {
  listReviewThreads: (owner: string, repo: string, prNumber: number) => Promise<unknown[]>;
}).listReviewThreads;

describe('listReviewThreads', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns resolution state and complete root/reply context from GraphQL', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [{
                  id: 'PRRT_thread',
                  isResolved: false,
                  isOutdated: false,
                  path: 'src/service.ts',
                  line: 42,
                  originalLine: 40,
                  comments: {
                    nodes: [
                      {
                        databaseId: 4243959293,
                        body: '🟢 Minor — 기존 지적입니다.',
                        author: { login: 'reviewer' },
                        createdAt: '2026-10-12T00:00:00.000Z',
                        updatedAt: '2026-10-12T00:00:00.000Z',
                        url: 'https://github.com/org/repo/pull/123#discussion_r4243959293',
                        replyTo: null,
                      },
                      {
                        databaseId: 4243959294,
                        body: '확인 부탁드립니다.',
                        author: { login: 'author' },
                        createdAt: '2026-10-12T01:00:00.000Z',
                        updatedAt: '2026-10-12T01:00:00.000Z',
                        url: 'https://github.com/org/repo/pull/123#discussion_r4243959294',
                        replyTo: { databaseId: 4243959293 },
                      },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      },
      headers: {},
    } as any);

    const threads = await listReviewThreads('org', 'repo', 123) as Array<Record<string, any>>;

    expect(threads).toEqual([expect.objectContaining({
      id: 'PRRT_thread',
      rootCommentId: 4243959293,
      isResolved: false,
      isOutdated: false,
      path: 'src/service.ts',
      comments: [
        expect.objectContaining({ id: 4243959293, user: { login: 'reviewer' }, inReplyToId: null }),
        expect.objectContaining({ id: 4243959294, user: { login: 'author' }, inReplyToId: 4243959293 }),
      ],
    })]);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://api.github.com/graphql',
      expect.objectContaining({
        query: expect.stringContaining('isResolved'),
        variables: { owner: 'org', repo: 'repo', number: 123, cursor: null },
      }),
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    const requestBody = mockedAxios.post.mock.calls[0][1] as { query: string; variables: Record<string, unknown> };
    expect(requestBody.query).toContain('isOutdated');
  });

  it('fails closed when GitHub returns GraphQL errors instead of thread state', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { errors: [{ message: 'Resource not accessible by integration' }] },
      headers: {},
    } as any);

    await expect(listReviewThreads('org', 'repo', 123)).rejects.toThrow('Resource not accessible by integration');
  });
});
