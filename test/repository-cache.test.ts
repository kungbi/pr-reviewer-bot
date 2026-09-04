import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import {
  DiscoveredRepository,
  RepositoryCache,
} from '../src/review/repository-cache';

function git(args: string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function createRemote(root: string, name: string): Promise<{ remote: string; head: string }> {
  const work = path.join(root, `${name}-work`);
  const remote = path.join(root, `${name}.git`);
  await fs.mkdir(work, { recursive: true });
  git(['init', '-b', 'main'], work);
  git(['config', 'user.name', 'Repository Cache Test'], work);
  git(['config', 'user.email', 'cache-test@example.invalid'], work);
  await fs.writeFile(path.join(work, 'README.md'), `${name}\n`, 'utf8');
  git(['add', 'README.md'], work);
  git(['commit', '-m', 'initial'], work);
  const head = git(['rev-parse', 'HEAD'], work);
  git(['clone', '--bare', work, remote], root);
  return { remote, head };
}

function discovered(owner: string, repo: string, cloneUrl: string): DiscoveredRepository {
  return {
    owner,
    repo,
    fullName: `${owner}/${repo}`,
    description: `${repo} service`,
    defaultBranch: 'main',
    cloneUrl,
  };
}

describe('RepositoryCache', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'repository-cache-test-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('pre-clones every accessible repository and updates existing clones on the next sync', async () => {
    const first = await createRemote(root, 'api');
    const second = await createRemote(root, 'worker');
    const repositories = [
      discovered('team', 'api', first.remote),
      discovered('team', 'worker', second.remote),
    ];
    const cacheRoot = path.join(root, 'cache');
    const cache = new RepositoryCache({
      rootDir: cacheRoot,
      token: 'not-persisted-token',
      gitTimeoutMs: 30_000,
      discoverRepositories: async () => repositories,
    });

    await expect(cache.syncAll()).resolves.toMatchObject({ total: 2, cloned: 2, updated: 0, failed: [] });
    await expect(cache.syncAll()).resolves.toMatchObject({ total: 2, cloned: 0, updated: 2, failed: [] });

    const catalog = cache.getCatalog();
    expect(catalog.map((repo) => repo.fullName)).toEqual(['team/api', 'team/worker']);
    await expect(fs.access(path.join(cacheRoot, 'team', 'api', '.git'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(cacheRoot, 'team', 'worker', '.git'))).resolves.toBeUndefined();

    const storedConfig = await fs.readFile(path.join(cacheRoot, 'team', 'api', '.git', 'config'), 'utf8');
    expect(storedConfig).not.toContain('not-persisted-token');
    const manifest = JSON.parse(await fs.readFile(cache.getCatalogPath(), 'utf8'));
    expect(manifest.repositories).toHaveLength(2);
  });

  it('refuses a cached repository path that is a symlink outside the cache root', async () => {
    const source = await createRemote(root, 'api');
    const outside = path.join(root, 'outside');
    git(['clone', source.remote, outside], root);
    const cacheRoot = path.join(root, 'cache');
    await fs.mkdir(path.join(cacheRoot, 'team'), { recursive: true });
    await fs.symlink(outside, path.join(cacheRoot, 'team', 'api'));
    const cache = new RepositoryCache({
      rootDir: cacheRoot,
      token: 'token',
      gitTimeoutMs: 30_000,
      discoverRepositories: async () => [discovered('team', 'api', source.remote)],
    });

    const result = await cache.syncAll();

    expect(result).toMatchObject({ total: 1, cloned: 0, updated: 0 });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].reason).toContain('symbolic link');
    expect(cache.getCatalog()).toEqual([]);
  });

  it('creates an exact PR-head worktree from the persistent cache and removes only the worktree', async () => {
    const source = await createRemote(root, 'api');
    git(['update-ref', 'refs/pull/7/head', source.head], source.remote);
    const cache = new RepositoryCache({
      rootDir: path.join(root, 'cache'),
      token: 'token',
      gitTimeoutMs: 30_000,
      discoverRepositories: async () => [discovered('team', 'api', source.remote)],
    });
    await cache.syncAll();

    const workspace = await cache.preparePRWorkspace({ owner: 'team', repo: 'api', prNumber: 7 });
    expect(workspace.ok).toBe(true);
    if (!workspace.ok) throw new Error(workspace.reason);
    expect(workspace.headSha).toBe(source.head);
    expect(git(['rev-parse', 'HEAD'], workspace.path)).toBe(source.head);
    await expect(fs.readFile(path.join(workspace.path, 'README.md'), 'utf8')).resolves.toBe('api\n');

    await cache.cleanupPRWorkspace(workspace.path);

    await expect(fs.access(workspace.path)).rejects.toThrow();
    await expect(fs.access(path.join(root, 'cache', 'team', 'api', '.git'))).resolves.toBeUndefined();
  });
});
