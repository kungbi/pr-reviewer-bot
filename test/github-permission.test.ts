import axios from 'axios';
import { getRepositoryPermission, postReviewCommentReply } from '../src/github';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('getRepositoryPermission', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns GitHub legacy write/read permission values used for maintain/triage roles', async () => {
    mockedAxios.get.mockResolvedValue({
      data: { permission: 'write' },
      headers: {},
    } as any);

    await expect(getRepositoryPermission('owner', 'repo', 'maintainer')).resolves.toBe('write');
    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo/collaborators/maintainer/permission',
      expect.objectContaining({ headers: expect.any(Object) }),
    );

    mockedAxios.get.mockResolvedValueOnce({
      data: { permission: 'read' },
      headers: {},
    } as any);
    await expect(getRepositoryPermission('owner', 'repo', 'triage-user')).resolves.toBe('read');
  });

  it('fails closed for a non-collaborator or an unexpected permission value', async () => {
    mockedAxios.get.mockRejectedValueOnce({ response: { status: 404 } });
    await expect(getRepositoryPermission('owner', 'repo', 'external')).resolves.toBe('none');

    mockedAxios.get.mockResolvedValueOnce({
      data: { permission: 'unknown-future-value' },
      headers: {},
    } as any);
    await expect(getRepositoryPermission('owner', 'repo', 'external')).resolves.toBe('none');
  });

  it('preserves a confirmed reply POST result even when the response exhausts the rate limit', async () => {
    mockedAxios.post.mockResolvedValue({
      data: { id: 999, html_url: 'https://example.com/reply' },
      headers: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '4102444800',
      },
    } as any);

    await expect(postReviewCommentReply('owner', 'repo', 1, 100, 'body')).resolves.toEqual({
      id: 999,
      html_url: 'https://example.com/reply',
    });
  });
});
