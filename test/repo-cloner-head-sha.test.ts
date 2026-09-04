jest.mock('../src/utils/config', () => ({
  __esModule: true,
  default: {
    ghToken: 'test-token',
    prCloneDepth: 200,
    prCloneTimeoutMs: 30_000,
  },
}));

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import fs from 'fs/promises';
import { spawn } from 'child_process';
import { cloneRepoForPR, cleanupClone } from '../src/review/repo-cloner';

const mockSpawn = spawn as jest.Mock;
const CHECKED_OUT_SHA = '0123456789abcdef0123456789abcdef01234567';

function successfulGitProcess(stdout = ''): EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: jest.Mock;
} {
  const process = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: jest.Mock;
  };
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.kill = jest.fn();
  queueMicrotask(() => {
    if (stdout) process.stdout.write(stdout);
    process.stdout.end();
    process.stderr.end();
    process.emit('close', 0);
  });
  return process;
}

describe('cloneRepoForPR checked-out SHA', () => {
  beforeEach(() => {
    mockSpawn.mockImplementation((_command: string, args: string[]) => (
      successfulGitProcess(args[0] === 'rev-parse' ? `${CHECKED_OUT_SHA}\n` : '')
    ));
  });

  it('returns the exact checked-out HEAD so the publisher cannot reuse an earlier API SHA', async () => {
    const result = await cloneRepoForPR({ owner: 'team', repo: 'api', prNumber: 7 });

    expect(result).toMatchObject({ ok: true, headSha: CHECKED_OUT_SHA });
    expect(mockSpawn).toHaveBeenLastCalledWith(
      'git',
      ['rev-parse', 'HEAD'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    );

    if (result.ok) await cleanupClone(result.path);
  });
});
