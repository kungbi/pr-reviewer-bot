import axios from 'axios';
import { getRepositoryPermission } from '../src/github';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('getRepositoryPermission', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns a verified write-level permission from GitHub', async () => {
    mockedAxios.get.mockResolvedValue({
      data: { permission: 'maintain' },
      headers: {},
    } as any);

    await expect(getRepositoryPermission('owner', 'repo', 'maintainer')).resolves.toBe('maintain');
    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo/collaborators/maintainer/permission',
      expect.objectContaining({ headers: expect.any(Object) }),
    );
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
});
