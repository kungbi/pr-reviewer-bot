/**
 * sessions_spawn — CLI 코딩 에이전트(claude | opencode | codex)를 스폰해 AI 분석 실행
 *
 * config.reviewAgent에 따라 설정된 에이전트를 non-interactive로 실행하고,
 * 결과 텍스트를 반환한다. 프롬프트 전달 방식
 * (stdin vs positional arg)은 에이전트별로 buildAgentInvocation이 결정한다.
 */
import { spawn } from 'child_process';
import config from './config';
import { buildAgentInvocation, buildAgentSpawnPath } from './agent-command';

interface SpawnOptions {
  cwd?: string;
  timeoutMs?: number;
}

// Extra grace after the soft timeout before force-killing with SIGKILL.
const KILL_GRACE_MS = 30_000;

const LOCAL_GITHUB_CREDENTIAL_ENV_NAMES = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GITHUB_PAT',
  'GH_ENTERPRISE_TOKEN',
] as const;

/**
 * The review publisher owns local GitHub write credentials. Analysis agents
 * must use only the authentication available in their own configured profile.
 */
export function buildReviewAgentEnvironment(parentEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnvironment = { ...parentEnvironment };
  for (const name of LOCAL_GITHUB_CREDENTIAL_ENV_NAMES) {
    delete childEnvironment[name];
  }
  return childEnvironment;
}

export class ModelCapacityError extends Error {
  readonly code = 'server_overloaded';

  constructor(
    readonly detail: string,
    readonly stage?: 'primary' | 'ponytail' | 'verifier',
    readonly attempts?: number,
  ) {
    super(`server_overloaded${stage ? ` at ${stage}` : ''}: ${detail}`);
    this.name = 'ModelCapacityError';
  }
}

const MODEL_CAPACITY_PATTERN = /server_overloaded|selected model is at capacity/i;

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getTerminalCapacityDetail(event: JsonRecord): string | null {
  if (event.type !== 'turn.failed' || !isJsonRecord(event.error)) return null;

  const code = event.error.code;
  const message = event.error.message;
  if (code === 'server_overloaded' ||
      (typeof message === 'string' && MODEL_CAPACITY_PATTERN.test(message))) {
    return JSON.stringify(event.error);
  }
  return null;
}

/**
 * Codex `exec --json` emits newline-delimited lifecycle events. Keep only the
 * final agent response; terminal errors are machine-readable and must not be
 * collapsed into a generic non-zero subprocess error.
 */
export function parseCodexExecJsonl(output: string): string {
  const messages: string[] = [];
  let capacityDetail: string | null = null;

  for (const line of output.split('\n')) {
    if (!line.trim()) continue;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isJsonRecord(event)) continue;

    const item = isJsonRecord(event.item) ? event.item : null;
    const isAgentMessage = item?.type === 'agent_message';
    if (isAgentMessage && typeof item.text === 'string' && item.text.trim()) {
      messages.push(item.text.trim());
      continue;
    }

    const capacityError = getTerminalCapacityDetail(event);
    if (capacityError) {
      capacityDetail = capacityError;
    }
  }

  if (capacityDetail) {
    throw new ModelCapacityError(capacityDetail);
  }
  const finalMessage = messages.at(-1);
  if (!finalMessage) {
    throw new Error('Codex JSONL completed without an agent message');
  }
  return finalMessage;
}

export async function sessions_spawn(prompt: string, options?: SpawnOptions): Promise<string> {
  const { command, args, promptViaStdin } = buildAgentInvocation(
    prompt,
    config.reviewAgent,
    config.reviewModel,
    config.codexReasoningEffort,
    config.hermesProfile,
  );
  console.log(`[sessions_spawn] Spawning ${command} for analysis...`);

  const timeoutMs = options?.timeoutMs ?? config.reviewTimeoutMs;

  return new Promise((resolve, reject) => {
    const spawnOpts: Parameters<typeof spawn>[2] = {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env: {
        ...buildReviewAgentEnvironment(process.env),
        PATH: buildAgentSpawnPath(process.env.PATH, process.env.HOME),
      },
    };
    if (options?.cwd) {
      spawnOpts.cwd = options.cwd;
    }

    const proc = spawn(command, args, spawnOpts);

    let output = '';
    let errorOutput = '';
    let settled = false;

    // Hard backstop: if `claude` ignores the SIGTERM from the spawn timeout
    // and never emits 'close', SIGKILL it and reject — so this Promise is
    // guaranteed to settle and never hangs a review slot forever.
    const killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.error('[sessions_spawn] Timed out — sending SIGKILL');
      proc.kill('SIGKILL');
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs + KILL_GRACE_MS);

    proc.stdout!.on('data', (data: Buffer) => {
      output += data.toString();
    });

    proc.stderr!.on('data', (data: Buffer) => {
      errorOutput += data.toString();
    });

    proc.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      if (code === 0) {
        try {
          const trimmed = command === 'codex'
            ? parseCodexExecJsonl(output)
            : output.trim();
          console.log(`[sessions_spawn] Completed (${trimmed.length} chars)`);
          resolve(trimmed);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      } else {
        try {
          if (command === 'codex') parseCodexExecJsonl(output);
        } catch (error) {
          if (error instanceof ModelCapacityError) {
            reject(error);
            return;
          }
        }
        console.error(`[sessions_spawn] Exited with code ${code}:`, errorOutput.slice(0, 500));
        reject(new Error(`${command} exited with code ${code}: ${errorOutput.slice(0, 200)}`));
      }
    });

    proc.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      reject(new Error(`Failed to spawn ${command}: ${err.message}`));
    });

    // 프롬프트 전달: claude는 stdin, opencode는 이미 argv에 포함됨.
    if (promptViaStdin) {
      proc.stdin!.write(prompt);
    }
    proc.stdin!.end();
  });
}
