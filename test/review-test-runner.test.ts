import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DockerExecutionResult,
  DockerInvoker,
  runReviewTestRunner,
} from '../src/review/review-test-runner';

const TRUSTED_IMAGE = `sha256:${'a'.repeat(64)}`;
const REGISTRY_TARBALL = 'https://registry.npmjs.org/example/-/example-1.0.0.tgz';

describe('runReviewTestRunner', () => {
  let testRoot: string;
  let sourcePath: string;
  let scratchRoot: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'review-test-runner-test-'));
    sourcePath = path.join(testRoot, 'pr-source');
    scratchRoot = path.join(testRoot, 'scratch');
    fs.mkdirSync(sourcePath, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  function makeProject(options: {
    runtime?: string | null;
    lock?: Record<string, unknown> | string;
    packageJson?: Record<string, unknown>;
  } = {}): void {
    const packageJson = options.packageJson ?? {
      name: 'fixture',
      version: '1.0.0',
      scripts: { test: 'node -e "process.exit(0)"' },
    };
    writeJson(path.join(sourcePath, 'package.json'), packageJson);
    const lock = options.lock ?? {
      name: 'fixture',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'fixture', version: '1.0.0' },
        'node_modules/example': {
          version: '1.0.0',
          resolved: REGISTRY_TARBALL,
          integrity: 'sha512-abc',
        },
      },
    };
    fs.writeFileSync(
      path.join(sourcePath, 'package-lock.json'),
      typeof lock === 'string' ? lock : `${JSON.stringify(lock, null, 2)}\n`,
    );
    if (options.runtime !== null) {
      fs.writeFileSync(path.join(sourcePath, '.nvmrc'), `${options.runtime ?? '20.11.1'}\n`);
    }
  }

  function successfulDocker(testOutput = 'tests passed'):
    { calls: string[][]; invoke: DockerInvoker } {
    const calls: string[][] = [];
    const invoke: DockerInvoker = async (args) => {
      calls.push([...args]);
      if (args[0] === 'image') return { exitCode: 0, stdout: TRUSTED_IMAGE, stderr: '' };
      if (args[0] === 'inspect') return { exitCode: 0, stdout: '{}', stderr: '' };
      if (args.includes('rm')) return { exitCode: 0, stdout: '', stderr: '' };
      if (args.includes('run')) {
        const isTest = args.includes('npm') && !args.includes('ci');
        return { exitCode: 0, stdout: isTest ? testOutput : 'installed', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    return { calls, invoke };
  }

  function runWith(invoke: DockerInvoker) {
    return runReviewTestRunner(sourcePath, {
      scratchRoot,
      docker: invoke,
      trustedNodeImages: { '20.11.1': TRUSTED_IMAGE },
      installTimeoutMs: 30_000,
      testTimeoutMs: 30_000,
    });
  }

  it('retains separately bounded sanitized stdout and stderr on failure', async () => {
    makeProject();
    const docker = successfulDocker();
    const result = await runWith(async (args, options) => args.includes('npm') && !args.includes('ci')
      ? { exitCode: 2, stdout: 'x'.repeat(9000), stderr: 'FAIL <assertion> & token=supersecret' }
      : docker.invoke(args, options));
    expect(result.test.exitCode).toBe(2);
    expect((result.test as any).stdout).toContain('[output truncated]');
    expect((result.test as any).stderr).toContain('FAIL <assertion> &');
    expect((result.test as any).stderr).not.toContain('supersecret');
  });

  it('uses a private default scratch parent and cleans each run', async () => {
    makeProject();
    const tmp = jest.spyOn(os, 'tmpdir').mockReturnValue(testRoot);
    try {
      const docker = successfulDocker();
      const result = await runReviewTestRunner(sourcePath, {
        docker: docker.invoke, trustedNodeImages: { '20.11.1': TRUSTED_IMAGE },
      });
      expect(result.test.status).toBe('passed');
      const parent = path.join(testRoot, 'pr-reviewer-bot-test-runner');
      expect(fs.statSync(parent).mode & 0o777).toBe(0o700);
      expect(fs.readdirSync(parent)).toEqual([]);
    } finally { tmp.mockRestore(); }
  });

  it('refuses a symlink in an ancestor of the scratch path', async () => {
    makeProject();
    const target = path.join(testRoot, 'target');
    fs.mkdirSync(target, { mode: 0o700 });
    const link = path.join(testRoot, 'link');
    fs.symlinkSync(target, link);
    scratchRoot = path.join(link, 'scratch');
    const docker = successfulDocker();
    const result = await runWith(docker.invoke);
    expect(result.reason).toMatch(/scratch/i);
    expect(docker.calls).toHaveLength(0);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it('refuses a publicly accessible existing scratch parent without changing it', async () => {
    makeProject();
    fs.mkdirSync(scratchRoot, { mode: 0o755 });
    fs.chmodSync(scratchRoot, 0o755);
    const docker = successfulDocker();
    const result = await runWith(docker.invoke);
    expect(result.reason).toMatch(/scratch/i);
    expect(docker.calls).toHaveLength(0);
    expect(fs.statSync(scratchRoot).mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(scratchRoot)).toEqual([]);
  });

  it('refuses a symlink in the scratch path', async () => {
    makeProject();
    const target = path.join(testRoot, 'target');
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, scratchRoot);
    const docker = successfulDocker();
    const result = await runWith(docker.invoke);
    expect(result.reason).toMatch(/scratch/i);
    expect(docker.calls).toHaveLength(0);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it('blocks before Docker without an explicit trusted image mapping', async () => {
    makeProject();
    const docker = successfulDocker();
    const result = await runReviewTestRunner(sourcePath, { scratchRoot, docker: docker.invoke });
    expect(result.status).toBe('blocked');
    expect(result.reason).toMatch(/trusted.*image/i);
    expect(docker.calls).toHaveLength(0);
  });

  it('does not execute an image when inspection does not match the trusted ID', async () => {
    makeProject();
    const calls: string[][] = [];
    const docker: DockerInvoker = async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: `sha256:${'b'.repeat(64)}`, stderr: '' };
    };
    const result = await runReviewTestRunner(sourcePath, {
      scratchRoot, docker, trustedNodeImages: { '20.11.1': `sha256:${'a'.repeat(64)}` },
    });
    expect(result.status).toBe('blocked');
    expect(result.reason).toMatch(/image/i);
    expect(calls.some(call => call[0] === 'run')).toBe(false);
  });

  it('reports successful tests as inconclusive when npm lifecycle scripts were suppressed', async () => {
    makeProject();
    const image = `sha256:${'a'.repeat(64)}`;
    const docker = successfulDocker();
    const result = await runReviewTestRunner(sourcePath, {
      scratchRoot, trustedNodeImages: { '20.11.1': image },
      docker: async (args, options) => args[0] === 'image'
        ? { exitCode: 0, stdout: image, stderr: '' } : docker.invoke(args, options),
    });
    expect(result.status).toBe('blocked');
    expect(result.reason).toMatch(/lifecycle|ignore-scripts/i);
    expect(result.install.status).toBe('passed');
    expect(result.test.status).toBe('passed');
    expect(docker.calls.find(call => call[0] === 'run')).toContain(image);
  });

  it('rejects mutable tags as trusted image configuration without invoking Docker', async () => {
    makeProject();
    const docker = successfulDocker();
    const result = await runReviewTestRunner(sourcePath, {
      scratchRoot, docker: docker.invoke, trustedNodeImages: { '20.11.1': 'node:20.11.1-bookworm-slim' },
    });
    expect(result.status).toBe('blocked');
    expect(docker.calls).toHaveLength(0);
  });

  it('ignores a poisoned node tag and executes only the verified immutable image ID', async () => {
    makeProject();
    const docker = successfulDocker();
    const result = await runWith(docker.invoke);
    expect(result.test.status).toBe('passed');
    expect(docker.calls[0]).toEqual(['image', 'inspect', '--format', '{{.Id}}', TRUSTED_IMAGE]);
    const start = docker.calls.find(call => call[0] === 'run')!;
    expect(start).toContain(TRUSTED_IMAGE);
    expect(start).not.toContain('node:20.11.1-bookworm-slim');
  });

  it('preserves a failed test stage while reporting reduced fidelity as blocked', async () => {
    makeProject();
    const docker = successfulDocker();
    const result = await runWith(async (args, options) => args[0] === 'exec' && args.includes('test')
      ? { exitCode: 1, stdout: '', stderr: 'test failed' } : docker.invoke(args, options));
    expect(result.status).toBe('blocked');
    expect(result.reason).toMatch(/ignore-scripts/);
    expect(result.test.status).toBe('failed');
    expect(result.test.exitCode).toBe(1);
  });

  it('blocks without invoking Docker when the package manifest is absent', async () => {
    const docker = successfulDocker();

    const result = await runWith(docker.invoke);

    expect(result.status).toBe('blocked');
    expect(result.install.status).toBe('not_run');
    expect(result.test.status).toBe('not_run');
    expect(result.reason).toMatch(/package\.json/i);
    expect(docker.calls).toHaveLength(0);
  });

  it('blocks when package.json is a symlink instead of a regular file', async () => {
    fs.writeFileSync(path.join(testRoot, 'real-package.json'), JSON.stringify({ name: 'fixture' }));
    fs.symlinkSync(path.join(testRoot, 'real-package.json'), path.join(sourcePath, 'package.json'));
    fs.writeFileSync(path.join(sourcePath, 'package-lock.json'), '{}');
    fs.writeFileSync(path.join(sourcePath, '.nvmrc'), '20.11.1');
    const docker = successfulDocker();

    const result = await runWith(docker.invoke);

    expect(result.status).toBe('blocked');
    expect(result.reason).toMatch(/regular.*package\.json|package\.json.*regular/i);
    expect(docker.calls).toHaveLength(0);
  });

  it('blocks if no npm lockfile is present', async () => {
    writeJson(path.join(sourcePath, 'package.json'), { name: 'fixture' });
    fs.writeFileSync(path.join(sourcePath, '.nvmrc'), '20.11.1');
    const docker = successfulDocker();

    const result = await runWith(docker.invoke);

    expect(result.status).toBe('blocked');
    expect(result.reason).toMatch(/package-lock\.json|npm-shrinkwrap\.json/);
    expect(docker.calls).toHaveLength(0);
  });

  it('blocks on an unsupported or ambiguous exact Node runtime', async () => {
    makeProject({
      runtime: '20.11.1',
      packageJson: {
        name: 'fixture',
        version: '1.0.0',
        engines: { node: '18.20.4' },
        scripts: { test: 'node -e "process.exit(0)"' },
      },
    });
    const docker = successfulDocker();

    const result = await runWith(docker.invoke);

    expect(result.status).toBe('blocked');
    expect(result.reason).toMatch(/ambiguous|conflict/i);
    expect(docker.calls).toHaveLength(0);
  });

  it('blocks when the only runtime declaration is a semver range', async () => {
    makeProject({
      runtime: null,
      packageJson: {
        name: 'fixture',
        version: '1.0.0',
        engines: { node: '>=20' },
        scripts: { test: 'node -e "process.exit(0)"' },
      },
    });
    const docker = successfulDocker();

    const result = await runWith(docker.invoke);

    expect(result.status).toBe('blocked');
    expect(result.reason).toMatch(/exact.*Node|Node.*exact|runtime/i);
    expect(docker.calls).toHaveLength(0);
  });

  it.each([
    ['HTTP tarball URL', 'http://registry.npmjs.org/example/-/example-1.0.0.tgz'],
    ['arbitrary HTTPS host', 'https://packages.example.invalid/example-1.0.0.tgz'],
    ['Git URL', 'git+https://github.com/example/repo.git'],
    ['file URL', 'file:../example'],
  ])('blocks an unsafe lockfile resolved URL (%s)', async (_label, resolved) => {
    makeProject({
      lock: {
        name: 'fixture',
        lockfileVersion: 3,
        packages: {
          '': { name: 'fixture', version: '1.0.0' },
          'node_modules/example': { version: '1.0.0', resolved },
        },
      },
    });
    const docker = successfulDocker();

    const result = await runWith(docker.invoke);

    expect(result.status).toBe('blocked');
    expect(result.reason).toMatch(/lock|URL|registry|dependency/i);
    expect(docker.calls).toHaveLength(0);
  });

  it('blocks Git and local-path manifest dependencies even if lock URLs look safe', async () => {
    makeProject({
      packageJson: {
        name: 'fixture',
        version: '1.0.0',
        scripts: { test: 'node -e "process.exit(0)"' },
        dependencies: { unsafe: 'git+https://github.com/example/unsafe.git' },
      },
    });
    const docker = successfulDocker();

    const result = await runWith(docker.invoke);

    expect(result.status).toBe('blocked');
    expect(result.reason).toMatch(/dependency|Git|file|URL/i);
    expect(docker.calls).toHaveLength(0);
  });

  it('blocks malformed and unsupported npm lockfiles', async () => {
    for (const invalidLock of ['{not json', JSON.stringify({ lockfileVersion: 1, dependencies: {} })]) {
      makeProject({ lock: invalidLock });
      const docker = successfulDocker();

      const result = await runWith(docker.invoke);

      expect(result.status).toBe('blocked');
      expect(result.reason).toMatch(/lock/i);
      expect(docker.calls).toHaveLength(0);
      fs.rmSync(sourcePath, { recursive: true, force: true });
      fs.mkdirSync(sourcePath, { recursive: true });
    }
  });

  it('blocks non-npm lockfiles rather than guessing the package manager', async () => {
    makeProject();
    fs.writeFileSync(path.join(sourcePath, 'yarn.lock'), '# yarn v1\n');
    const docker = successfulDocker();

    const result = await runWith(docker.invoke);

    expect(result.status).toBe('blocked');
    expect(result.reason).toMatch(/npm|yarn|package manager|ecosystem/i);
    expect(docker.calls).toHaveLength(0);
  });

  it('blocks if a CI test script is discoverable but is not declared by the package', async () => {
    makeProject();
    fs.mkdirSync(path.join(sourcePath, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(
      path.join(sourcePath, '.github', 'workflows', 'ci.yml'),
      'jobs:\n  test:\n    steps:\n      - run: npm run test:ci\n',
    );
    const docker = successfulDocker();

    const result = await runWith(docker.invoke);

    expect(result.status).toBe('blocked');
    expect(result.reason).toMatch(/test:ci|script/i);
    expect(docker.calls).toHaveLength(0);
  });

  it('uses one bounded container and verifies detachment before running tests', async () => {
    makeProject();
    const docker = successfulDocker();
    const result = await runWith(docker.invoke);
    expect(result.status).toBe('blocked');
    const start = docker.calls.find(call => call[0] === 'run')!;
    expect(start).toEqual(expect.arrayContaining(['--read-only', '--cap-drop=ALL', '--pull=never']));
    expect(start.some(arg => arg.includes('type=bind') && arg.includes('readonly'))).toBe(true);
    expect(start.some(arg => arg.includes('tmpfs') && arg.includes('size='))).toBe(true);
    const detach = docker.calls.findIndex(call => call[0] === 'network');
    const inspect = docker.calls.findIndex(call => call[0] === 'inspect');
    const test = docker.calls.findIndex(call => call[0] === 'exec' && call.includes('test'));
    expect(detach).toBeGreaterThan(-1);
    expect(inspect).toBeGreaterThan(detach);
    expect(test).toBeGreaterThan(inspect);
    expect(docker.calls[docker.calls.length - 1]?.[0]).toBe('rm');
  });

  it('fails closed when network isolation cannot be verified', async () => {
    makeProject();
    const docker = successfulDocker();
    const result = await runWith(async (args, options) => args[0] === 'inspect'
      ? { exitCode: 0, stdout: '{"bridge":{}}', stderr: '' }
      : docker.invoke(args, options));
    expect(result.status).toBe('blocked');
    expect(result.install.status).toBe('passed');
    expect(result.test.status).toBe('not_run');
    expect(docker.calls.some(call => call[0] === 'exec' && call.includes('test'))).toBe(false);
    expect(docker.calls[docker.calls.length - 1]?.[0]).toBe('rm');
  });
  it.each([
    ['install failure', 'ci', { exitCode: 1, stdout: '', stderr: 'bad' }, 'failed'],
    ['install timeout', 'ci', { exitCode: null, stdout: '', stderr: '', timedOut: true }, 'failed'],
    ['install infrastructure error', 'ci', { exitCode: null, stdout: '', stderr: '', error: 'unavailable' }, 'blocked'],
  ])('preserves stage status on %s and removes the container', async (_name, command, execution, status) => {
    makeProject();
    const docker = successfulDocker();
    const result = await runWith(async (args, options) => args[0] === 'exec' && args.includes(command)
      ? execution : docker.invoke(args, options));
    expect(result.status).toBe(status);
    expect(result.install.status).toBe(status);
    expect(result.test.status).toBe('not_run');
    expect(docker.calls[docker.calls.length - 1]?.[0]).toBe('rm');
  });

  it('does not run tests after a disconnect failure', async () => {
    makeProject();
    const docker = successfulDocker();
    const result = await runWith(async (args, options) => args[0] === 'network'
      ? { exitCode: 1, stdout: '', stderr: 'failure' } : docker.invoke(args, options));
    expect(result.status).toBe('blocked');
    expect(result.install.status).toBe('passed');
    expect(result.test.status).toBe('not_run');
    expect(docker.calls[docker.calls.length - 1]?.[0]).toBe('rm');
  });

  it('records reduced fidelity when sensitive files are excluded', async () => {
    makeProject();
    fs.writeFileSync(path.join(sourcePath, '.env'), 'PRIVATE');
    const result = await runWith(successfulDocker().invoke);
    expect(result.status).toBe('blocked');
    expect(result.test.status).toBe('passed');
    expect(result.reason).toMatch(/fidelity/);
  });

});