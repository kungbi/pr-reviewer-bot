/**
 * sessions_spawn — CLI 코딩 에이전트(claude | opencode)를 스폰해 AI 분석 실행
 *
 * config.reviewAgent에 따라 claude 또는 opencode를 non-interactive로 실행하고,
 * 결과 텍스트(마지막 줄의 VERDICT 포함)를 반환한다. 프롬프트 전달 방식
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

export async function sessions_spawn(prompt: string, options?: SpawnOptions): Promise<string> {
  const { command, args, promptViaStdin } = buildAgentInvocation(
    prompt,
    config.reviewAgent,
    config.reviewModel,
  );
  console.log(`[sessions_spawn] Spawning ${command} for analysis...`);

  const timeoutMs = options?.timeoutMs ?? config.reviewTimeoutMs;

  return new Promise((resolve, reject) => {
    const spawnOpts: Parameters<typeof spawn>[2] = {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env: {
        ...process.env,
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
        const trimmed = output.trim();
        console.log(`[sessions_spawn] Completed (${trimmed.length} chars)`);
        resolve(trimmed);
      } else {
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
