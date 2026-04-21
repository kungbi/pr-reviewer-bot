/**
 * repo-cloner.ts
 *
 * Clones a GitHub repo to a temp directory, checks out the PR branch,
 * and returns the path for use as cwd in sessions_spawn.
 *
 * On any failure, self-cleans the temp dir and returns { ok: false, reason }.
 * Token is NEVER logged — only a masked URL is used in log output.
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import config from '../utils/config';
import logger from '../utils/logger';
import { CloneFailureReason, CloneResult } from '../types/clone.types';

interface CloneParams {
  owner: string;
  repo: string;
  prNumber: number;
}

/**
 * Runs a git command with the given args in the given cwd.
 * Rejects with an object containing `stderr` on non-zero exit.
 */
function runGit(
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    let timedOut = false;

    const proc = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
      reject({ timedOut: true, stderr });
    }, timeoutMs);

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (timedOut) return; // already rejected
      if (code === 0) {
        resolve();
      } else {
        reject({ timedOut: false, stderr, code });
      }
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject({ timedOut: false, stderr, code: null, notFound: err.code === 'ENOENT' });
    });
  });
}

/**
 * Classify stderr into a CloneFailureReason.
 */
function classifyStderr(stderr: string): CloneFailureReason {
  const s = stderr.toLowerCase();
  if (s.includes('authentication failed') || s.includes('could not read username') ||
      s.includes('invalid username') || s.includes('403')) {
    return 'auth_failed';
  }
  if (s.includes('couldn\'t find remote ref') || s.includes('unknown revision') ||
      s.includes('not found')) {
    return 'ref_missing';
  }
  if (s.includes('shallow') || s.includes('merge base') || s.includes('deepen')) {
    return 'depth_insufficient';
  }
  return 'unknown';
}

/**
 * Silently remove a directory tree. Idempotent — swallows all errors.
 */
export async function cleanupClone(dirPath: string): Promise<void> {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch {
    // Intentionally swallowed — cleanup is best-effort
  }
}

/**
 * Clone the repo for a given PR and check out its branch.
 * Returns { ok: true, path } on success, { ok: false, reason } on any failure.
 * On failure, the temp directory is cleaned up before returning.
 */
export async function cloneRepoForPR({ owner, repo, prNumber }: CloneParams): Promise<CloneResult> {
  const prefix = path.join(os.tmpdir(), `pr-reviewer-${owner}-${repo}-${prNumber}-`);

  let tmpDir: string | null = null;

  try {
    tmpDir = await fs.mkdtemp(prefix);
    await fs.chmod(tmpDir, 0o700);

    const token = config.ghToken;
    if (!token) {
      logger.warn('[repo-cloner] GH_TOKEN not set — cannot clone via HTTPS token');
      await cleanupClone(tmpDir);
      return { ok: false, reason: 'auth_failed' };
    }

    // Build clone URL with token — NEVER log this
    const cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
    const maskedUrl = `https://x-access-token:***@github.com/${owner}/${repo}.git`;

    const depth = config.prCloneDepth;
    const timeoutMs = config.prCloneTimeoutMs;

    logger.info(`[repo-cloner] Cloning ${maskedUrl} --depth=${depth} into ${tmpDir}`);

    // ── Step 1: git clone ──────────────────────────────────────────────────
    try {
      await runGit(
        ['clone', `--depth=${depth}`, '--no-tags', cloneUrl, tmpDir],
        os.tmpdir(),
        timeoutMs
      );
    } catch (err: unknown) {
      const e = err as { timedOut?: boolean; stderr?: string; notFound?: boolean };
      if (e.notFound) {
        logger.warn('[repo-cloner] git binary not found (ENOENT)');
        await cleanupClone(tmpDir);
        return { ok: false, reason: 'git_not_found' };
      }
      if (e.timedOut) {
        logger.warn('[repo-cloner] git clone timed out');
        await cleanupClone(tmpDir);
        return { ok: false, reason: 'timeout' };
      }
      const reason = classifyStderr(e.stderr ?? '');
      logger.error(`[repo-cloner] git clone failed (${reason})`);
      await cleanupClone(tmpDir);
      return { ok: false, reason };
    }

    // ── Step 2: git fetch origin pull/<N>/head:pr-<N> ─────────────────────
    try {
      await runGit(
        ['fetch', 'origin', `pull/${prNumber}/head:pr-${prNumber}`],
        tmpDir,
        timeoutMs
      );
    } catch (err: unknown) {
      const e = err as { timedOut?: boolean; stderr?: string };
      if (e.timedOut) {
        logger.warn('[repo-cloner] git fetch (PR ref) timed out');
        await cleanupClone(tmpDir);
        return { ok: false, reason: 'timeout' };
      }
      const stderr = e.stderr ?? '';
      const reason = classifyStderr(stderr);

      // If depth-related, retry once with --deepen=200
      if (reason === 'depth_insufficient') {
        logger.warn('[repo-cloner] Depth may be insufficient — retrying with --deepen=200');
        try {
          await runGit(['fetch', '--deepen=200', 'origin', `pull/${prNumber}/head:pr-${prNumber}`], tmpDir, timeoutMs);
        } catch {
          logger.error('[repo-cloner] git fetch retry with --deepen=200 also failed');
          await cleanupClone(tmpDir);
          return { ok: false, reason: 'depth_insufficient' };
        }
      } else {
        logger.error(`[repo-cloner] git fetch (PR ref) failed (${reason})`);
        await cleanupClone(tmpDir);
        return { ok: false, reason };
      }
    }

    // ── Step 3: git checkout pr-<N> ───────────────────────────────────────
    try {
      await runGit(['checkout', `pr-${prNumber}`], tmpDir, timeoutMs);
    } catch (err: unknown) {
      const e = err as { timedOut?: boolean; stderr?: string };
      if (e.timedOut) {
        logger.warn('[repo-cloner] git checkout timed out');
        await cleanupClone(tmpDir);
        return { ok: false, reason: 'timeout' };
      }
      const reason = classifyStderr(e.stderr ?? '');
      logger.error(`[repo-cloner] git checkout failed (${reason})`);
      await cleanupClone(tmpDir);
      return { ok: false, reason };
    }

    logger.info(`[repo-cloner] Clone ready at ${tmpDir}`);
    return { ok: true, path: tmpDir };

  } catch (err: unknown) {
    // Unexpected error (e.g. mkdtemp failed)
    logger.error(`[repo-cloner] Unexpected error: ${(err as Error).message}`);
    if (tmpDir) {
      await cleanupClone(tmpDir);
    }
    return { ok: false, reason: 'unknown' };
  }
}
