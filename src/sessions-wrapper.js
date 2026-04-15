/**
 * Sessions Wrapper - Provides sessions_spawn function for subagent spawning
 */

const { spawn } = require('child_process');

/**
 * Spawn a session to generate AI content using OpenClaw agents run
 * @param {string} prompt - The prompt to send to the AI
 * @returns {Promise<string>} Generated content
 */
async function sessions_spawn(prompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn('openclaw', [
      'agents', 'run',
      '--model', 'minimax/MiniMax-M2.7',
      '--prompt', prompt
    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    let error = '';

    proc.stdout.on('data', (data) => {
      output += data.toString();
    });
    proc.stderr.on('data', (data) => {
      error += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(output.trim());
      } else {
        console.error('[sessions_spawn] Error:', error);
        reject(new Error(`sessions_spawn exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

module.exports = { sessions_spawn };
