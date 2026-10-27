import axios from 'axios';
import { getPRDetails } from '../src/github';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const baseSha = '0123456789abcdef0123456789abcdef01234567';
const headSha = 'abcdef0123456789abcdef0123456789abcdef01';

describe('getPRDetails authoritative commit metadata', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.GH_TOKEN = 'test-token';
    mockedAxios.get.mockResolvedValue({
      data: {
        number: 12,
        title: 'Pinned metadata',
        state: 'open',
        user: { login: 'author' },
        html_url: 'https://github.com/acme/service/pull/12',
        head: { ref: 'feature', sha: headSha },
        base: { ref: 'main', sha: baseSha },
        labels: [],
        requested_reviewers: [],
      },
      headers: {},
    } as any);
  });

  it('returns the exact base/head refs and SHAs from GitHub REST PR details', async () => {
    const details = await getPRDetails('acme', 'service', 12);

    expect(details).toMatchObject({
      headRefName: 'feature',
      headSha,
      baseRefName: 'main',
      baseSha,
    });
  });
});
