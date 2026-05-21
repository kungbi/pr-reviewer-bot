/**
 * sessions_spawn — Claude CLI로 AI 분석 실행
 *
 * claude -p (non-interactive print mode)로 프롬프트를 stdin으로 넘기고
 * 결과 텍스트를 반환한다.
 */
import { spawn } from 'child_process';
import config from './config';

interface SpawnOptions {
  cwd?: string;
  timeoutMs?: number;
}

// Extra grace after the soft timeout before force-killing with SIGKILL.
const KILL_GRACE_MS = 30_000;

export async function sessions_spawn(prompt: string, options?: SpawnOptions): Promise<string> {
  console.log('[sessions_spawn] Spawning claude -p for analysis...');

  const timeoutMs = options?.timeoutMs ?? config.reviewTimeoutMs;

  return new Promise((resolve, reject) => {
    const spawnOpts: Parameters<typeof spawn>[2] = {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
    };
    if (options?.cwd) {
      spawnOpts.cwd = options.cwd;
    }

    const proc = spawn('claude', [
      '-p',
      '--model', config.reviewModel,
      '--dangerously-skip-permissions',
    ], spawnOpts);

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
      reject(new Error(`claude timed out after ${timeoutMs}ms`));
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
        reject(new Error(`claude exited with code ${code}: ${errorOutput.slice(0, 200)}`));
      }
    });

    proc.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    // 프롬프트를 stdin으로 전달
    proc.stdin!.write(prompt);
    proc.stdin!.end();
  });
}
