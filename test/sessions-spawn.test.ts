import { buildReviewAgentEnvironment } from '../src/utils/sessions_spawn';

describe('buildReviewAgentEnvironment', () => {
  it('does not pass local GitHub write credentials to a review agent child process', () => {
    const parentEnvironment = {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/bot',
      GH_TOKEN: 'local-write-token',
      GITHUB_TOKEN: 'another-write-token',
      GITHUB_PAT: 'pat-token',
      GH_ENTERPRISE_TOKEN: 'enterprise-token',
      SAFE_SETTING: 'retained',
    };

    const childEnvironment = buildReviewAgentEnvironment(parentEnvironment);

    expect(childEnvironment).toMatchObject({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/bot',
      SAFE_SETTING: 'retained',
    });
    expect(childEnvironment.GH_TOKEN).toBeUndefined();
    expect(childEnvironment.GITHUB_TOKEN).toBeUndefined();
    expect(childEnvironment.GITHUB_PAT).toBeUndefined();
    expect(childEnvironment.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(parentEnvironment.GH_TOKEN).toBe('local-write-token');
  });
});
