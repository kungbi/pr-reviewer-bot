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
}

export async function sessions_spawn(prompt: string, options?: SpawnOptions): Promise<string> {
  console.log('[sessions_spawn] Spawning claude -p for analysis...');

  return new Promise((resolve, reject) => {
    const spawnOpts: Parameters<typeof spawn>[2] = {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: config.reviewTimeoutMs,
    };
    if (options?.cwd) {
      spawnOpts.cwd = options.cwd;
    }

    const proc = spawn('claude', [
      '-p',
      '--dangerously-skip-permissions',
    ], spawnOpts);

    let output = '';
    let errorOutput = '';

    proc.stdout!.on('data', (data: Buffer) => {
      output += data.toString();
    });

    proc.stderr!.on('data', (data: Buffer) => {
      errorOutput += data.toString();
    });

    proc.on('close', (code: number | null) => {
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
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    // 프롬프트를 stdin으로 전달
    proc.stdin!.write(prompt);
    proc.stdin!.end();
  });
}
