/**
 * sessions_spawn — Spawn an openclaw agent session to perform a task.
 *
 * Supports two calling conventions:
 *   1. sessions_spawn(promptString)
 *      → calls openclaw agent, returns the output TEXT directly
 *      → used by review-executor.js (the main AI review path)
 *
 *   2. sessions_spawn({ task, description, instructions })
 *      → calls openclaw agent, returns { success, output }
 *      → used by webhook-handler.js
 *
 * @param {string|object} arg
 * @returns {Promise<{success: boolean, output: string}|string>}
 */
async function sessions_spawn(arg) {
  // Determine calling convention
  const isObjectCall = arg !== null && typeof arg === 'object' && !Array.isArray(arg);

  let task, message;

  if (isObjectCall) {
    // Convention 2: object — used by webhook-handler.js
    const { task: t, description = '', instructions = '', context } = arg;
    task = t || 'pr-review';
    message = [description, '', instructions].join('\n');
    console.log(`[sessions_spawn] Spawning agent for task: ${task}`);
    if (context) console.log(`[sessions_spawn] Context: ${JSON.stringify(context)}`);
  } else {
    // Convention 1: plain string — used by review-executor.js
    task = 'pr-analysis';
    message = String(arg);
    console.log(`[sessions_spawn] Spawning agent for pr-analysis`);
  }

  const sessionKey = `pr-review-${task}`;

  // Escape for shell safety
  const escaped = message.replace(/'/g, "'\\''");

  // Use --message on CLI (not stdin) to avoid TTY detection issues
  const cmd = `openclaw agent --agent main --session-id '${sessionKey}' --message '${escaped}'`;

  let output;
  try {
    const { execSync } = require('child_process');
    output = execSync(cmd, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120 * 1000,
    });
    console.log(`[sessions_spawn] Agent completed for task: ${task}`);
  } catch (err) {
    console.error(`[sessions_spawn] Agent failed (task=${task}):`, err.message);
    throw err;
  }

  const trimmed = output.trim();

  // Convention 1: return TEXT directly (review-executor.js expects this)
  if (!isObjectCall) return trimmed;

  // Convention 2: return structured result (webhook-handler.js expects this)
  return { success: true, output: trimmed };
}

module.exports = { sessions_spawn };