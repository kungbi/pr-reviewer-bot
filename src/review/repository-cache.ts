import axios from 'axios';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import config from '../utils/config';
import logger from '../utils/logger';
import { CloneFailureReason, CloneResult } from '../types/clone.types';
import { RepositoryCatalogEntry } from './repository-selection';

const GH_API = 'https://api.github.com';
const REPOSITORY_SEGMENT = /^[A-Za-z0-9_.-]+$/;

export interface DiscoveredRepository {
  owner: string;
  repo: string;
  fullName: string;
  description: string | null;
  defaultBranch: string;
  cloneUrl: string;
}

export interface RepositoryCacheSyncResult {
  total: number;
  cloned: number;
  updated: number;
  failed: Array<{ fullName: string; reason: string }>;
}

export interface RepositoryCacheOptions {
  rootDir: string;
  token: string | null;
  gitTimeoutMs: number;
  discoverRepositories?: () => Promise<DiscoveredRepository[]>;
}

interface WorkspaceRecord {
  repositoryPath: string;
  containerPath: string;
}

interface GitHubRepositoryResponse {
  name?: unknown;
  full_name?: unknown;
  description?: unknown;
  default_branch?: unknown;
  clone_url?: unknown;
  owner?: { login?: unknown };
}

function isSafeSegment(value: string): boolean {
  return REPOSITORY_SEGMENT.test(value) && value !== '.' && value !== '..';
}

function validateRepository(repository: DiscoveredRepository): void {
  if (!isSafeSegment(repository.owner) || !isSafeSegment(repository.repo)) {
    throw new Error(`unsafe repository name: ${repository.fullName}`);
  }
  if (repository.fullName.toLowerCase() !== `${repository.owner}/${repository.repo}`.toLowerCase()) {
    throw new Error(`repository identity mismatch: ${repository.fullName}`);
  }
}

function gitAuthEnvironment(token: string | null): NodeJS.ProcessEnv {
  if (!token) return { ...process.env };
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  return {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_TERMINAL_PROMPT: '0',
  };
}

function runGit(
  args: string[],
  cwd: string,
  timeoutMs: number,
  token: string | null,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: gitAuthEnvironment(token),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`git command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`git exited with code ${code}: ${stderr.trim().slice(0, 1000)}`));
      }
    });
  });
}

function normalizeGitHubRepository(value: GitHubRepositoryResponse): DiscoveredRepository | null {
  const owner = value.owner?.login;
  const repo = value.name;
  const fullName = value.full_name;
  const defaultBranch = value.default_branch;
  const cloneUrl = value.clone_url;
  if (typeof owner !== 'string' || typeof repo !== 'string' || typeof fullName !== 'string' ||
      typeof defaultBranch !== 'string' || typeof cloneUrl !== 'string') {
    return null;
  }
  const repository: DiscoveredRepository = {
    owner,
    repo,
    fullName,
    description: typeof value.description === 'string' ? value.description : null,
    defaultBranch,
    cloneUrl,
  };
  validateRepository(repository);
  return repository;
}

export async function discoverAccessibleRepositories(token: string | null): Promise<DiscoveredRepository[]> {
  if (!token) {
    throw new Error('GH_TOKEN is required to enumerate every accessible repository');
  }

  const repositories: DiscoveredRepository[] = [];
  for (let page = 1; ; page += 1) {
    const response = await axios.get<GitHubRepositoryResponse[]>(`${GH_API}/user/repos`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      params: {
        visibility: 'all',
        affiliation: 'owner,collaborator,organization_member',
        sort: 'full_name',
        direction: 'asc',
        per_page: 100,
        page,
      },
    });
    const pageRepositories = Array.isArray(response.data) ? response.data : [];
    for (const value of pageRepositories) {
      const repository = normalizeGitHubRepository(value);
      if (repository) repositories.push(repository);
    }
    if (pageRepositories.length < 100) break;
  }

  const deduplicated = new Map<string, DiscoveredRepository>();
  for (const repository of repositories) {
    deduplicated.set(repository.fullName.toLowerCase(), repository);
  }
  return [...deduplicated.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
}

function classifyCloneFailure(error: unknown): CloneFailureReason {
  const message = (error as Error).message.toLowerCase();
  if (message.includes('timed out')) return 'timeout';
  if (message.includes('authentication') || message.includes('403') || message.includes('401')) return 'auth_failed';
  if (message.includes('remote ref') || message.includes('not found')) return 'ref_missing';
  if (message.includes('enoent')) return 'git_not_found';
  return 'unknown';
}

export class RepositoryCache {
  private readonly rootDir: string;
  private readonly token: string | null;
  private readonly gitTimeoutMs: number;
  private readonly discoverRepositories: () => Promise<DiscoveredRepository[]>;
  private catalog: RepositoryCatalogEntry[] = [];
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly repositoryLocks = new Map<string, Promise<void>>();

  constructor(options: RepositoryCacheOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.token = options.token;
    this.gitTimeoutMs = options.gitTimeoutMs;
    this.discoverRepositories = options.discoverRepositories ?? (() => discoverAccessibleRepositories(this.token));
  }

  getCatalogPath(): string {
    return path.join(this.rootDir, 'repositories.json');
  }

  getCatalog(): RepositoryCatalogEntry[] {
    return this.catalog.map((entry) => ({ ...entry }));
  }

  private repositoryPath(owner: string, repo: string): string {
    if (!isSafeSegment(owner) || !isSafeSegment(repo)) {
      throw new Error(`unsafe repository path: ${owner}/${repo}`);
    }
    return path.join(this.rootDir, owner, repo);
  }

  private async assertCachePathSafe(owner: string, repo: string): Promise<void> {
    const candidates = [this.rootDir, path.join(this.rootDir, owner), this.repositoryPath(owner, repo)];
    for (const candidate of candidates) {
      try {
        const stat = await fs.lstat(candidate);
        if (stat.isSymbolicLink()) {
          throw new Error(`repository cache path contains a symbolic link: ${candidate}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
    }
  }

  private async withRepositoryLock<T>(fullName: string, operation: () => Promise<T>): Promise<T> {
    const key = fullName.toLowerCase();
    const previous = this.repositoryLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.repositoryLocks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.repositoryLocks.get(key) === queued) {
        this.repositoryLocks.delete(key);
      }
    }
  }

  private async refreshRepository(entry: RepositoryCatalogEntry): Promise<void> {
    await this.withRepositoryLock(entry.fullName, async () => {
      await this.assertCachePathSafe(entry.owner, entry.repo);
      await runGit(
        ['fetch', '--prune', '--no-tags', 'origin', '+refs/heads/*:refs/remotes/origin/*'],
        entry.path,
        this.gitTimeoutMs,
        this.token,
      );
      await runGit(['worktree', 'prune'], entry.path, this.gitTimeoutMs, this.token);
    });
  }

  async syncAll(): Promise<RepositoryCacheSyncResult> {
    const discovered = await this.discoverRepositories();
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });

    const result: RepositoryCacheSyncResult = {
      total: discovered.length,
      cloned: 0,
      updated: 0,
      failed: [],
    };
    const available: RepositoryCatalogEntry[] = [];

    for (const repository of discovered) {
      try {
        validateRepository(repository);
        const repositoryPath = this.repositoryPath(repository.owner, repository.repo);
        await this.assertCachePathSafe(repository.owner, repository.repo);
        const gitDirectory = path.join(repositoryPath, '.git');
        let existing = false;
        try {
          existing = (await fs.stat(gitDirectory)).isDirectory();
        } catch {
          existing = false;
        }

        if (existing) {
          const entry: RepositoryCatalogEntry = {
            owner: repository.owner,
            repo: repository.repo,
            fullName: repository.fullName,
            description: repository.description,
            defaultBranch: repository.defaultBranch,
            path: repositoryPath,
          };
          await this.refreshRepository(entry);
          result.updated += 1;
        } else {
          await fs.rm(repositoryPath, { recursive: true, force: true });
          await fs.mkdir(path.dirname(repositoryPath), { recursive: true, mode: 0o700 });
          await runGit(
            ['clone', '--filter=blob:none', '--no-tags', repository.cloneUrl, repositoryPath],
            this.rootDir,
            this.gitTimeoutMs,
            this.token,
          );
          result.cloned += 1;
        }

        available.push({
          owner: repository.owner,
          repo: repository.repo,
          fullName: repository.fullName,
          description: repository.description,
          defaultBranch: repository.defaultBranch,
          path: repositoryPath,
        });
      } catch (error) {
        result.failed.push({ fullName: repository.fullName, reason: (error as Error).message });
        logger.error(`[repository-cache] Failed to sync ${repository.fullName}: ${(error as Error).message}`);
      }
    }

    this.catalog = available.sort((a, b) => a.fullName.localeCompare(b.fullName));
    const manifest = JSON.stringify({
      updatedAt: new Date().toISOString(),
      repositories: this.catalog,
    }, null, 2);
    const tempCatalogPath = `${this.getCatalogPath()}.tmp-${process.pid}`;
    await fs.writeFile(tempCatalogPath, manifest, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tempCatalogPath, this.getCatalogPath());
    return result;
  }

  async refreshRepositories(fullNames: string[]): Promise<void> {
    const catalog = new Map(this.catalog.map((entry) => [entry.fullName.toLowerCase(), entry]));
    for (const fullName of [...new Set(fullNames.map((value) => value.toLowerCase()))]) {
      const entry = catalog.get(fullName);
      if (!entry) throw new Error(`repository is not in the local cache catalog: ${fullName}`);
      await this.refreshRepository(entry);
    }
  }

  async preparePRWorkspace(params: { owner: string; repo: string; prNumber: number }): Promise<CloneResult> {
    const fullName = `${params.owner}/${params.repo}`;
    const entry = this.catalog.find((candidate) => candidate.fullName.toLowerCase() === fullName.toLowerCase());
    if (!entry) return { ok: false, reason: 'ref_missing' };

    let containerPath: string | null = null;
    try {
      return await this.withRepositoryLock(entry.fullName, async () => {
        await this.assertCachePathSafe(entry.owner, entry.repo);
        await runGit(
          ['fetch', '--prune', '--no-tags', 'origin', '+refs/heads/*:refs/remotes/origin/*'],
          entry.path,
          this.gitTimeoutMs,
          this.token,
        );
        const reviewRef = `refs/pr-reviewer/pull/${params.prNumber}`;
        await runGit(
          ['fetch', '--no-tags', 'origin', `+refs/pull/${params.prNumber}/head:${reviewRef}`],
          entry.path,
          this.gitTimeoutMs,
          this.token,
        );
        const workspaceHeadSha = await runGit(['rev-parse', reviewRef], entry.path, this.gitTimeoutMs, this.token);
        await runGit(['worktree', 'prune'], entry.path, this.gitTimeoutMs, this.token);

        containerPath = await fs.mkdtemp(path.join(os.tmpdir(), `pr-reviewer-${params.owner}-${params.repo}-${params.prNumber}-`));
        await fs.chmod(containerPath, 0o700);
        const workspacePath = path.join(containerPath, 'worktree');
        await runGit(['worktree', 'add', '--detach', workspacePath, reviewRef], entry.path, this.gitTimeoutMs, this.token);
        this.workspaces.set(path.resolve(workspacePath), {
          repositoryPath: entry.path,
          containerPath,
        });
        return { ok: true, path: workspacePath, headSha: workspaceHeadSha };
      });
    } catch (error) {
      if (containerPath) await fs.rm(containerPath, { recursive: true, force: true });
      logger.error(`[repository-cache] Failed to prepare ${fullName}#${params.prNumber}: ${(error as Error).message}`);
      return { ok: false, reason: classifyCloneFailure(error) };
    }
  }

  async cleanupPRWorkspace(workspacePath: string): Promise<void> {
    const key = path.resolve(workspacePath);
    const workspace = this.workspaces.get(key);
    if (!workspace) {
      await fs.rm(workspacePath, { recursive: true, force: true });
      return;
    }

    try {
      await runGit(['worktree', 'remove', '--force', key], workspace.repositoryPath, this.gitTimeoutMs, this.token);
      await runGit(['worktree', 'prune'], workspace.repositoryPath, this.gitTimeoutMs, this.token);
    } catch (error) {
      logger.warn(`[repository-cache] Worktree cleanup failed for ${workspacePath}: ${(error as Error).message}`);
    } finally {
      this.workspaces.delete(key);
      await fs.rm(workspace.containerPath, { recursive: true, force: true });
    }
  }
}

let sharedRepositoryCache: RepositoryCache | undefined;

export function getSharedRepositoryCache(): RepositoryCache {
  if (!sharedRepositoryCache) {
    sharedRepositoryCache = new RepositoryCache({
      rootDir: config.repositoryCacheDirectory,
      token: config.ghToken,
      gitTimeoutMs: config.repositoryCacheGitTimeoutMs,
    });
  }
  return sharedRepositoryCache;
}
