// Run after npm run build. All state writes and fake GitHub calls stay in fixtures.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repository = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewbot-relocated-'));
try {
  const release = path.join(scratch, 'release', 'dist');
  const runtime = path.join(scratch, 'operator-cwd');
  fs.mkdirSync(runtime, { recursive: true });
  fs.cpSync(path.join(repository, 'dist'), release, { recursive: true });
  fs.symlinkSync(path.join(repository, 'node_modules'), path.join(scratch, 'release', 'node_modules'), 'dir');
  // No ts-jest/source imports: exercise the actual relocated CommonJS build.
  const env = { ...process.env, NODE_ENV: 'test', DISCORD_WEBHOOK_URL: 'https://example.invalid/test', LOG_LEVEL: 'ERROR' };
  delete env.PR_REVIEWER_RUNTIME_ROOT;
  delete env.REPOSITORY_CACHE_DIRECTORY;
  const result = spawnSync(process.execPath, [
    path.join(repository, 'node_modules', 'jest', 'bin', 'jest.js'),
    '--runInBand', '--config', JSON.stringify({ rootDir: release, testEnvironment: 'node', transform: {},
      testMatch: ['**/test/runtime-state-paths.test.js', '**/test/review-executor-report-integration.test.js'] }),
  ], { cwd: runtime, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Relocated runtime smoke failed (${result.status})`);
  if (fs.existsSync(path.join(scratch, 'release', 'state')) || fs.existsSync(path.join(release, 'state'))) {
    throw new Error('Relocated runtime incorrectly wrote release-local state');
  }
  console.log('Relocated compiled runtime smoke passed; release-local state absent.');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
