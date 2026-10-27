import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

export type ReviewTestStatus = 'passed' | 'failed' | 'blocked' | 'not_run';

export interface ReviewTestStageResult {
  status: ReviewTestStatus;
  reason?: string;
  exitCode?: number;
  output?: string;
  stdout?: string;
  stderr?: string;
}

export interface ReviewTestRunnerResult {
  status: Exclude<ReviewTestStatus, 'not_run'>;
  reason: string;
  nodeVersion?: string;
  testCommand?: string;
  install: ReviewTestStageResult;
  test: ReviewTestStageResult;
}

export interface DockerExecutionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  error?: string;
}

export interface DockerInvocationOptions {
  timeoutMs: number;
  configDir: string;
}

/** Receives Docker CLI arguments without shell interpretation. */
export type DockerInvoker = (
  args: string[],
  options: DockerInvocationOptions,
) => Promise<DockerExecutionResult>;

export interface ReviewTestRunnerOptions {
  /** Parent directory for a private, unique, disposable runner workspace. */
  scratchRoot?: string;
  /** Mock this function in unit tests; it is the only Docker execution seam. */
  docker?: DockerInvoker;
  /** Operator-trusted local Docker image IDs, keyed by exact Node version. Never accept PR-controlled values. */
  trustedNodeImages?: Readonly<Record<string, string>>;
  installTimeoutMs?: number;
  testTimeoutMs?: number;
}

const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_LOCK_BYTES = 32_000_000;
const MAX_WORKFLOW_BYTES = 2_000_000;
// Only the official public npm registry is allowlisted; alternate registries need an explicit review.
const PUBLIC_NPM_REGISTRY_HOST = 'registry.npmjs.org';
const NODE_VERSION_PATTERN = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ALLOWED_CI_TEST_SCRIPT = /^npm (?:test|run test(?::[A-Za-z0-9][A-Za-z0-9_-]*)?)$/;
const NON_NPM_LOCKFILES = ['yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'];
class BlockedInputError extends Error {}

interface ProjectPlan {
  nodeVersion: string;
  lockfileName: 'package-lock.json' | 'npm-shrinkwrap.json';
  testCommand: string;
  testScriptName: string;
}

interface ExactRuntimeDeclaration {
  source: string;
  version: string;
}

interface WorkflowRuntimeDeclaration {
  rawValue: string;
  version?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function blockedResult(reason: string): ReviewTestRunnerResult {
  return {
    status: 'blocked',
    reason,
    install: { status: 'not_run', reason: 'Blocked before npm install.' },
    test: { status: 'not_run', reason: 'Blocked before the test command.' },
  };
}

function optionalLstat(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function readRegularText(filePath: string, maxBytes: number, label: string): string {
  let before: fs.Stats;
  try {
    before = fs.lstatSync(filePath);
  } catch {
    throw new BlockedInputError(`Required ${label} is missing or unreadable.`);
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new BlockedInputError(`${label} must be a regular, non-symlink file.`);
  }
  if (before.size > maxBytes) throw new BlockedInputError(`${label} exceeds the permitted size.`);

  let fileDescriptor: number;
  try {
    fileDescriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new BlockedInputError(`${label} could not be opened without following symlinks.`);
  }
  try {
    const opened = fs.fstatSync(fileDescriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new BlockedInputError(`${label} changed while it was being inspected.`);
    }
    if (opened.size > maxBytes) throw new BlockedInputError(`${label} exceeds the permitted size.`);
    return fs.readFileSync(fileDescriptor, 'utf8');
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new BlockedInputError(`${label} is not valid JSON.`);
  }
  if (!isRecord(parsed)) throw new BlockedInputError(`${label} must contain a JSON object.`);
  return parsed;
}

function normalizeExactNodeVersion(raw: string): string | undefined {
  const match = raw.trim().match(NODE_VERSION_PATTERN);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined;
}

function normalizeEngineNodeVersion(raw: string): string | undefined {
  const value = raw.trim().replace(/^=\s*/, '');
  return normalizeExactNodeVersion(value);
}

function validateRegistryUrl(value: string, context: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BlockedInputError(`${context} contains an invalid resolved URL.`);
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== PUBLIC_NPM_REGISTRY_HOST ||
    (url.port !== '' && url.port !== '443') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !url.pathname.startsWith('/')
  ) {
    throw new BlockedInputError(`${context} must resolve to an HTTPS tarball on ${PUBLIC_NPM_REGISTRY_HOST}.`);
  }
}

function validateDependencySpec(spec: unknown): void {
  if (typeof spec !== 'string' || spec.length === 0 || spec !== spec.trim()) {
    throw new BlockedInputError('A dependency has an invalid package specification.');
  }
  let value = spec;
  if (/^npm:/i.test(value)) {
    value = value.slice(4);
    if (value.length === 0 || /:\/\//.test(value)) {
      throw new BlockedInputError('A dependency has an unsupported npm alias specification.');
    }
  }
  if (/^(?:file|link|workspace|git|github|gitlab|bitbucket|ssh|http|ftp):/i.test(value) || /^git@/i.test(value)) {
    throw new BlockedInputError('A dependency uses an unsupported Git, HTTP, or local-file source.');
  }
  if (/^https:\/\//i.test(value)) {
    validateRegistryUrl(value, 'A package dependency');
    return;
  }
  if (/^(?:\.{1,2}(?:[\\/]|$)|[\\/]|[A-Za-z]:[\\/])/.test(value)) {
    throw new BlockedInputError('A dependency uses a local file path.');
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    throw new BlockedInputError('A dependency uses an unsupported URL or protocol.');
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#.*)?$/.test(value)) {
    throw new BlockedInputError('A dependency uses a GitHub shorthand source.');
  }
}

function validateManifestDependencies(manifest: Record<string, unknown>): void {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const raw = manifest[field];
    if (raw === undefined) continue;
    if (!isRecord(raw)) throw new BlockedInputError(`package.json ${field} must be an object.`);
    for (const spec of Object.values(raw)) validateDependencySpec(spec);
  }
  const manager = manifest.packageManager;
  if (manager !== undefined && (typeof manager !== 'string' || !/^npm(?:@|$)/i.test(manager))) {
    throw new BlockedInputError('Unsupported packageManager declaration; only npm projects are supported.');
  }
}

function validateLockfile(lock: Record<string, unknown>, manifest: Record<string, unknown>, lockfileName: string): void {
  if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) {
    throw new BlockedInputError(`${lockfileName} has an unsupported or invalid lockfileVersion; npm lockfile versions 2 and 3 are required.`);
  }
  const packages = lock.packages;
  if (!isRecord(packages) || !isRecord(packages[''])) {
    throw new BlockedInputError(`${lockfileName} is missing a valid npm packages map and root entry.`);
  }
  const rootEntry = packages[''];
  const manifestName = typeof manifest.name === 'string' ? manifest.name : undefined;
  const lockName = typeof lock.name === 'string'
    ? lock.name
    : (typeof rootEntry.name === 'string' ? rootEntry.name : undefined);
  if (manifestName && lockName && manifestName !== lockName) {
    throw new BlockedInputError(`${lockfileName} does not match package.json.`);
  }

  for (const [packagePath, entry] of Object.entries(packages)) {
    if (!isRecord(entry)) throw new BlockedInputError(`${lockfileName} contains an invalid package entry.`);
    if (packagePath === '') continue;
    if (entry.link === true) throw new BlockedInputError(`${lockfileName} contains a local or workspace package link.`);
    if (entry.resolved === undefined) {
      if (entry.inBundle !== true) {
        throw new BlockedInputError(`${lockfileName} is missing a registry resolved URL for a package entry.`);
      }
    } else if (typeof entry.resolved !== 'string') {
      throw new BlockedInputError(`${lockfileName} contains a non-string resolved URL.`);
    } else {
      validateRegistryUrl(entry.resolved, lockfileName);
    }
  }

  const visit = (value: unknown, where: string): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child, where);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'resolved' && child !== undefined) {
        if (typeof child !== 'string') throw new BlockedInputError(`${lockfileName} contains a non-string resolved URL.`);
        validateRegistryUrl(child, `${lockfileName} ${where}`);
      }
      if (key === 'link' && child === true) throw new BlockedInputError(`${lockfileName} contains a local package link.`);
      if (key === 'version' && typeof child === 'string' && /^(?:file|git|http|https|ssh):/i.test(child)) {
        throw new BlockedInputError(`${lockfileName} contains an unsupported dependency source.`);
      }
      visit(child, `${where}.${key}`);
    }
  };
  visit(lock, 'lock entry');
}

function yamlScalarValue(raw: string): string {
  const unCommented = raw.trim().replace(/\s+#.*$/, '').trim();
  if (
    (unCommented.startsWith("'") && unCommented.endsWith("'")) ||
    (unCommented.startsWith('"') && unCommented.endsWith('"'))
  ) {
    return unCommented.slice(1, -1);
  }
  return unCommented;
}

function workflowFiles(sourceRoot: string): string[] {
  const githubPath = path.join(sourceRoot, '.github');
  const githubStat = optionalLstat(githubPath);
  if (!githubStat || githubStat.isSymbolicLink() || !githubStat.isDirectory()) return [];
  const workflowsPath = path.join(githubPath, 'workflows');
  const workflowsStat = optionalLstat(workflowsPath);
  if (!workflowsStat || workflowsStat.isSymbolicLink() || !workflowsStat.isDirectory()) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(workflowsPath, { withFileTypes: true })) {
    if (!/\.ya?ml$/i.test(entry.name) || entry.isSymbolicLink() || !entry.isFile()) continue;
    const filePath = path.join(workflowsPath, entry.name);
    const stat = optionalLstat(filePath);
    if (stat?.isFile() && !stat.isSymbolicLink()) files.push(filePath);
  }
  return files;
}

function workflowRuntimeDeclarations(sourceRoot: string): WorkflowRuntimeDeclaration[] {
  const declarations: WorkflowRuntimeDeclaration[] = [];
  for (const workflowPath of workflowFiles(sourceRoot)) {
    const text = readRegularText(workflowPath, MAX_WORKFLOW_BYTES, 'CI workflow');
    const lines = text.split(/\r?\n/);
    const stepBlocks: string[][] = [];
    let currentBlock: string[] = [];
    for (const line of lines) {
      if (/^\s*-\s+/.test(line)) {
        if (currentBlock.length) stepBlocks.push(currentBlock);
        currentBlock = [line];
      } else if (currentBlock.length) {
        currentBlock.push(line);
      }
    }
    if (currentBlock.length) stepBlocks.push(currentBlock);

    for (const block of stepBlocks) {
      if (!block.some((line) => /^\s*(?:-\s*)?uses:\s*actions\/setup-node@/i.test(line))) continue;
      for (const line of block) {
        const match = line.match(/^\s*node-version\s*:\s*(.*?)\s*$/i);
        if (!match) continue;
        const rawValue = yamlScalarValue(match[1]);
        declarations.push({ rawValue, version: normalizeExactNodeVersion(rawValue) });
      }
    }
  }
  return declarations;
}

function workflowTestCommands(sourceRoot: string): string[] {
  const commands: string[] = [];
  for (const workflowPath of workflowFiles(sourceRoot)) {
    const text = readRegularText(workflowPath, MAX_WORKFLOW_BYTES, 'CI workflow');
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(/^(\s*)(?:-\s*)?run\s*:\s*(.*?)\s*$/);
      if (!match) continue;
      const scalar = yamlScalarValue(match[2]);
      if (scalar === '|' || scalar === '>' || scalar === '|-' || scalar === '>-') {
        const baseIndent = match[1].length;
        for (let next = index + 1; next < lines.length; next += 1) {
          const line = lines[next];
          if (line.trim() === '') continue;
          const indent = line.match(/^\s*/)?.[0].length ?? 0;
          if (indent <= baseIndent) break;
          const command = line.trim();
          if (ALLOWED_CI_TEST_SCRIPT.test(command)) commands.push(command);
        }
      } else if (ALLOWED_CI_TEST_SCRIPT.test(scalar)) {
        commands.push(scalar);
      }
    }
  }
  return [...new Set(commands)];
}

function selectNodeVersion(sourceRoot: string, manifest: Record<string, unknown>): string {
  const declarations: ExactRuntimeDeclaration[] = [];
  const nvmrcPath = path.join(sourceRoot, '.nvmrc');
  const nvmrcStat = optionalLstat(nvmrcPath);
  if (nvmrcStat) {
    const raw = readRegularText(nvmrcPath, 256, '.nvmrc');
    const version = normalizeExactNodeVersion(raw);
    if (!version) throw new BlockedInputError('.nvmrc must declare an exact Node version such as 20.12.2.');
    declarations.push({ source: '.nvmrc', version });
  }

  const engines = manifest.engines;
  if (engines !== undefined && !isRecord(engines)) {
    throw new BlockedInputError('package.json engines must be an object.');
  }
  if (isRecord(engines) && engines.node !== undefined) {
    if (typeof engines.node !== 'string') throw new BlockedInputError('package.json engines.node must be a string.');
    const version = normalizeEngineNodeVersion(engines.node);
    if (version) declarations.push({ source: 'package.json engines.node', version });
  }

  const workflowDeclarations = workflowRuntimeDeclarations(sourceRoot);
  if (!nvmrcStat && workflowDeclarations.some((declaration) => !declaration.version)) {
    throw new BlockedInputError('CI setup-node must declare an exact Node version; dynamic or ranged versions are ambiguous.');
  }
  for (const declaration of workflowDeclarations) {
    if (declaration.version) declarations.push({ source: 'CI setup-node node-version', version: declaration.version });
  }

  const versions = [...new Set(declarations.map((declaration) => declaration.version))];
  if (versions.length === 0) {
    throw new BlockedInputError('No exact Node runtime is declared in .nvmrc, package.json engines.node, or CI setup-node.');
  }
  if (versions.length > 1) {
    const sources = declarations.map((declaration) => `${declaration.source}=${declaration.version}`).join(', ');
    throw new BlockedInputError(`Ambiguous Node runtime declarations conflict: ${sources}.`);
  }
  return versions[0];
}

function getProjectPlan(sourceRoot: string): ProjectPlan {
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(sourceRoot);
  } catch {
    throw new BlockedInputError('PR source path is missing or inaccessible.');
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new BlockedInputError('PR source path must be a regular directory, not a symlink.');
  }
  const realSourceRoot = fs.realpathSync(sourceRoot);
  const packagePath = path.join(realSourceRoot, 'package.json');
  const manifest = parseJsonObject(readRegularText(packagePath, MAX_MANIFEST_BYTES, 'package.json'), 'package.json');
  validateManifestDependencies(manifest);

  for (const filename of NON_NPM_LOCKFILES) {
    if (optionalLstat(path.join(realSourceRoot, filename))) {
      throw new BlockedInputError(`Unsupported package ecosystem detected (${filename}); only npm lockfiles are supported.`);
    }
  }
  const shrinkwrapPath = path.join(realSourceRoot, 'npm-shrinkwrap.json');
  const packageLockPath = path.join(realSourceRoot, 'package-lock.json');
  const lockfileName = optionalLstat(shrinkwrapPath) ? 'npm-shrinkwrap.json' : 'package-lock.json';
  const lockPath = path.join(realSourceRoot, lockfileName);
  if (!optionalLstat(lockPath)) {
    throw new BlockedInputError('An npm package-lock.json or npm-shrinkwrap.json is required.');
  }
  const lock = parseJsonObject(readRegularText(lockPath, MAX_LOCK_BYTES, lockfileName), lockfileName);
  validateLockfile(lock, manifest, lockfileName);

  const nodeVersion = selectNodeVersion(realSourceRoot, manifest);
  const ciCommands = workflowTestCommands(realSourceRoot);
  if (ciCommands.length > 1) {
    throw new BlockedInputError('Multiple different npm test commands are declared in CI workflows.');
  }
  const testCommand = ciCommands[0] ?? 'npm test';
  const testScriptName = testCommand === 'npm test' ? 'test' : testCommand.slice('npm run '.length);
  const scripts = manifest.scripts;
  if (!isRecord(scripts) || typeof scripts[testScriptName] !== 'string' || scripts[testScriptName] === '') {
    throw new BlockedInputError(`The selected npm test script (${testScriptName}) is not declared in package.json.`);
  }
  return { nodeVersion, lockfileName, testCommand, testScriptName };
}

const EXCLUDED_DIRECTORY_NAMES = new Set(['.aws', '.azure', '.config', '.credentials', '.docker', '.gcloud', '.gnupg', '.hermes', '.kube', '.npm', '.secret', '.secrets', '.ssh', 'credentials', 'secrets', 'ssh']);
const EXCLUDED_FILE_NAMES = new Set(['.git-credentials', '.gitconfig', '.netrc', '.npmrc', '.pypirc']);
function excludedEntry(name: string, isDirectory: boolean): boolean {
  const lower = name.toLowerCase();
  if (lower === '.git' || lower === 'node_modules') return true;
  if (lower === '.env' || lower.startsWith('.env.')) return true;
  if (EXCLUDED_FILE_NAMES.has(lower)) return true;
  if (/^(?:credentials?|secrets?|tokens?)(?:\.[^.]+)?$/i.test(name)) return true;
  if (/\.(?:pem|p12|pfx|key)$/i.test(name)) return true;
  return isDirectory && EXCLUDED_DIRECTORY_NAMES.has(lower);
}

function copyFileWithoutFollowingSymlink(source: string, destination: string, expected: fs.Stats): void {
  let sourceFd: number;
  try {
    sourceFd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new BlockedInputError('PR source changed during the isolated copy; no files were followed through symlinks.');
  }
  let destinationFd: number | undefined;
  try {
    const opened = fs.fstatSync(sourceFd);
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
      throw new BlockedInputError('PR source changed during the isolated copy.');
    }
    const mode = (expected.mode & 0o111) !== 0 ? 0o755 : 0o644;
    destinationFd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const bytesRead = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        written += fs.writeSync(destinationFd, buffer, written, bytesRead - written);
      }
    }
    fs.fchmodSync(destinationFd, mode);
  } finally {
    if (destinationFd !== undefined) fs.closeSync(destinationFd);
    fs.closeSync(sourceFd);
  }
}

function copySourceTree(sourceRoot: string, destinationRoot: string): boolean {
  let fidelityExclusions = false;
  let totalBytes = 0;
  const walk = (sourceDirectory: string, destinationDirectory: string): void => {
    let directoryStat: fs.Stats;
    try {
      directoryStat = fs.lstatSync(sourceDirectory);
    } catch {
      throw new BlockedInputError('PR source changed during the isolated copy.');
    }
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) return;
    fs.mkdirSync(destinationDirectory, { recursive: true, mode: 0o755 });
    for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        fidelityExclusions = true;
        continue;
      }
      const name = entry.name;
      const source = path.join(sourceDirectory, name);
      const destination = path.join(destinationDirectory, name);
      const stat = optionalLstat(source);
      if (!stat || stat.isSymbolicLink() || excludedEntry(name, stat.isDirectory())) {
        if (name.toLowerCase() !== '.git' && name.toLowerCase() !== 'node_modules') fidelityExclusions = true;
        continue;
      }
      if (stat.isDirectory()) {
        walk(source, destination);
      } else if (stat.isFile()) {
        totalBytes += stat.size;
        if (totalBytes > 256 * 1024 * 1024) throw new BlockedInputError('Source exceeds the copy size limit.');
        copyFileWithoutFollowingSymlink(source, destination, stat);
      }
    }
  };
  walk(sourceRoot, destinationRoot);
  return fidelityExclusions;
}

function prepareScratchParent(requested: string): string {
  const scratch = path.resolve(requested);
  const parts = scratch.split(path.sep).filter(Boolean);
  let current = path.parse(scratch).root;
  const uid = process.getuid?.();
  if (uid === undefined) throw new BlockedInputError('Scratch directory ownership cannot be verified.');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat = optionalLstat(current);
    if (!stat && i === parts.length - 1) {
      try { fs.mkdirSync(current, { mode: 0o700 }); }
      catch { throw new BlockedInputError('Scratch parent could not be safely created.'); }
      stat = fs.lstatSync(current);
    }
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
      throw new BlockedInputError('Scratch path must contain only existing non-symlink directories.');
    }
    if (i === parts.length - 1) {
      if (stat.uid !== uid || (stat.mode & 0o7777) !== 0o700) {
        throw new BlockedInputError('Scratch parent must be owned by the runner and have mode 0700.');
      }
    } else if ((stat.uid !== uid && stat.uid !== 0) ||
      ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)) {
      throw new BlockedInputError('Scratch path has an untrusted ancestor directory.');
    }
  }
  return scratch;
}

function defaultDocker(args: string[], options: DockerInvocationOptions): Promise<DockerExecutionResult> {
  return new Promise(resolve => execFile('docker', ['--config', options.configDir, ...args], {
    env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: options.configDir, DOCKER_CONFIG: options.configDir },
    timeout: options.timeoutMs, maxBuffer: 1_000_000, killSignal: 'SIGKILL', encoding: 'utf8',
  }, (error, stdout, stderr) => {
    const e = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
    resolve({ exitCode: e ? (typeof e.code === 'number' ? e.code : null) : 0, stdout: String(stdout), stderr: String(stderr), timedOut: !!e?.killed, error: e && typeof e.code !== 'number' ? e.message : undefined });
  }));
}

function sanitizeOutput(value: string, workspaceRoot?: string): string {
  let sanitized = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|xox[a-z]-[A-Za-z0-9-]{20,})/g, '[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
    .replace(/https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+/gi, '[REDACTED_DISCORD_WEBHOOK]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:_authToken|authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret|token)\b(\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '?');
  if (workspaceRoot) sanitized = sanitized.split(workspaceRoot).join('<workspace>');
  if (sanitized.length > 8000) {
    const marker = '\n[output truncated]';
    sanitized = `${sanitized.slice(0, 8000 - marker.length)}${marker}`;
  }
  return sanitized;
}

function stage(result: DockerExecutionResult, label: string): ReviewTestStageResult {
  const stdout = sanitizeOutput(result.stdout);
  const stderr = sanitizeOutput(result.stderr);
  const output = { stdout, stderr, ...(result.exitCode === null ? {} : { exitCode: result.exitCode }) };
  if (result.timedOut) return { status: 'failed', reason: `${label} timed out.`, ...output };
  if (result.error || result.exitCode === null || [125, 126, 127].includes(result.exitCode)) return { status: 'blocked', reason: `Docker could not execute ${label}.`, ...output };
  return { status: result.exitCode === 0 ? 'passed' : 'failed', reason: `${label} exited with code ${result.exitCode}.`, ...output };
}

export async function runReviewTestRunner(sourcePath: string, options: ReviewTestRunnerOptions = {}): Promise<ReviewTestRunnerResult> {
  let plan: ProjectPlan;
  try { plan = getProjectPlan(path.resolve(sourcePath)); }
  catch (error) { return blockedResult(error instanceof BlockedInputError ? error.message : 'Runner preflight failed; no untrusted test command was run.'); }
  const result: ReviewTestRunnerResult = { ...blockedResult('Docker setup failed.'), nodeVersion: plan.nodeVersion, testCommand: plan.testCommand };
  const image = Object.prototype.hasOwnProperty.call(options.trustedNodeImages ?? {}, plan.nodeVersion)
    ? options.trustedNodeImages?.[plan.nodeVersion] : undefined;
  if (typeof image !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(image)) {
    result.reason = 'No trusted immutable image ID is configured for this Node version.';
    return result;
  }
  const docker = options.docker ?? defaultDocker;
  let root: string | undefined;
  const name = `review-test-${randomUUID()}`;
  let attempted = false;
  const timeout = (value: number | undefined, fallback: number) => value && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 900_000) : fallback;
  try {
    const scratch = prepareScratchParent(options.scratchRoot ?? path.join(fs.realpathSync(os.tmpdir()), 'pr-reviewer-bot-test-runner'));
    root = fs.mkdtempSync(path.join(scratch, 'run-'));
    const config = path.join(root, 'config'); fs.mkdirSync(config, { mode: 0o700 });
    const source = path.join(root, 'source');
    const excluded = copySourceTree(path.resolve(sourcePath), source);
    // Docker Desktop must be able to traverse the snapshot; it contains no credentials.
    fs.chmodSync(root, 0o755);
    if (/[\n\r,]/.test(source)) throw new BlockedInputError('Unsafe Docker mount path.');
    const call = (args: string[], ms = 30_000) => docker(args, { timeoutMs: ms, configDir: config });
    const inspectedImage = await call(['image', 'inspect', '--format', '{{.Id}}', image]);
    if (inspectedImage.exitCode !== 0 || inspectedImage.timedOut || inspectedImage.error || inspectedImage.stdout.trim() !== image) {
      result.reason = 'Trusted image ID could not be verified locally.';
      return result;
    }
    attempted = true;
    const start = await call(['run', '-d', '--rm', '--pull=never', `--name=${name}`, '--network=bridge', '--read-only', '--cpus=1', '--memory=1g', '--memory-swap=1g', '--pids-limit=128', '--security-opt=no-new-privileges', '--cap-drop=ALL', '--user=1000:1000', '--log-driver=none', '--tmpfs=/workspace:rw,nosuid,nodev,size=512m,uid=1000,gid=1000,mode=700', '--tmpfs=/tmp:rw,nosuid,nodev,size=128m,uid=1000,gid=1000,mode=700', `--mount=type=bind,src=${source},dst=/source,readonly`, '--workdir=/workspace', '--env=HOME=/tmp', '--env=TMPDIR=/tmp', '--env=NPM_CONFIG_CACHE=/tmp/npm-cache', '--env=NPM_CONFIG_USERCONFIG=/tmp/user.npmrc', '--env=NPM_CONFIG_GLOBALCONFIG=/tmp/global.npmrc', '--env=NPM_CONFIG_REGISTRY=https://registry.npmjs.org', '--env=NPM_CONFIG_AUDIT=false', '--env=NPM_CONFIG_FUND=false', '--entrypoint=/usr/bin/timeout', image, '1800', 'sleep', '1800']);
    if (start.exitCode !== 0 || start.timedOut || start.error) { result.reason = 'Docker container startup failed (local image required).'; return result; }
    const copy = await call(['exec', name, 'cp', '-R', '/source/.', '/workspace/'], 60_000);
    if (copy.exitCode !== 0 || copy.timedOut || copy.error) { result.reason = 'Failed to prepare bounded workspace.'; return result; }
    result.install = stage(await call(['exec', name, 'npm', 'ci', '--ignore-scripts'], timeout(options.installTimeoutMs, 600_000)), 'npm ci --ignore-scripts');
    if (result.install.status !== 'passed') { result.status = result.install.status === 'failed' ? 'failed' : 'blocked'; result.reason = result.install.reason!; return result; }
    const disconnect = await call(['network', 'disconnect', '--force', 'bridge', name]);
    if (disconnect.exitCode !== 0 || disconnect.timedOut || disconnect.error) { result.reason = 'Could not disconnect container network.'; return result; }
    const inspect = await call(['inspect', '--format', '{{json .NetworkSettings.Networks}}', name]);
    let networks: unknown;
    try { networks = JSON.parse(inspect.stdout); } catch { networks = null; }
    if (inspect.exitCode !== 0 || inspect.timedOut || inspect.error || !isRecord(networks) || Object.keys(networks).length !== 0) { result.reason = 'Container network isolation could not be verified.'; return result; }
    result.test = stage(await call(['exec', name, 'npm', ...(plan.testCommand === 'npm test' ? ['test'] : ['run', plan.testScriptName])], timeout(options.testTimeoutMs, 300_000)), plan.testCommand);
    result.status = 'blocked';
    result.reason = `Inconclusive: npm ci --ignore-scripts suppresses install lifecycle scripts${excluded ? ' and source exclusions reduce fidelity' : ''}.`;
    return result;
  } catch (error) {
    result.reason = error instanceof BlockedInputError ? error.message : 'Runner infrastructure failed.';
    return result;
  } finally {
    if (attempted && root) {
      try { await docker(['rm', '--force', name], { timeoutMs: 10_000, configDir: path.join(root, 'config') }); } catch { /* container watchdog bounds lifetime */ }
    }
    if (root) { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}
