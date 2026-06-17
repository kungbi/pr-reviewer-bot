/**
 * agent-command — build the spawn command/args for the configured review agent.
 *
 * Pure (no config / no side effects) so it can be unit-tested in isolation.
 * Three agents are supported:
 *   - claude   : `claude -p [--model <alias>] --dangerously-skip-permissions`
 *                prompt delivered via stdin.
 *   - opencode : `opencode run [--model <provider/model>] --dangerously-skip-permissions <prompt>`
 *                prompt delivered as a positional argument.
 *   - codex    : `codex exec [--model <name>] --dangerously-bypass-approvals-and-sandbox
 *                 --skip-git-repo-check <prompt>`
 *                prompt delivered as a positional argument. Uses the OpenAI Codex
 *                CLI, which works with ChatGPT-account OAuth (where opencode's
 *                openai path is blocked).
 */

export type ReviewAgent = 'claude' | 'opencode' | 'codex';

export interface AgentInvocation {
  command: string;
  args: string[];
  // When true, the prompt must be written to the process stdin.
  // When false, the prompt is already embedded in `args` as a positional arg.
  promptViaStdin: boolean;
}

export function buildAgentInvocation(
  prompt: string,
  agent: ReviewAgent,
  model: string | null,
): AgentInvocation {
  if (agent === 'opencode') {
    return {
      command: 'opencode',
      args: [
        'run',
        ...(model ? ['--model', model] : []),
        '--dangerously-skip-permissions',
        prompt,
      ],
      promptViaStdin: false,
    };
  }

  if (agent === 'codex') {
    return {
      command: 'codex',
      args: [
        'exec',
        ...(model ? ['--model', model] : []),
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
        prompt,
      ],
      promptViaStdin: false,
    };
  }

  // default: claude
  return {
    command: 'claude',
    args: [
      '-p',
      ...(model ? ['--model', model] : []),
      '--dangerously-skip-permissions',
    ],
    promptViaStdin: true,
  };
}

/**
 * Detect an agent/model format mismatch. The two agents expect different model
 * formats (claude: short alias like "opus"; opencode: "provider/model"), so a
 * value valid for one breaks the other. opencode exits 0 even on error, so a
 * misconfig would silently produce empty reviews — we surface it loudly at boot.
 *
 * Returns a human-readable error message, or null when the model is fine
 * (including when model is null → the agent uses its own default).
 */
export function modelAgentMismatch(agent: ReviewAgent, model: string | null): string | null {
  if (model === null) return null;
  const looksLikeProviderModel = model.includes('/');

  if (agent === 'opencode' && !looksLikeProviderModel) {
    return `REVIEW_AGENT=opencode requires OPENCODE_MODEL in "provider/model" form ` +
      `(e.g. "google/gemini-2.5-flash"), got: "${model}"`;
  }
  if (agent === 'claude' && looksLikeProviderModel) {
    return `REVIEW_AGENT=claude expects a short model alias (e.g. "opus"), ` +
      `but REVIEW_MODEL looks like a provider/model: "${model}"`;
  }
  if (agent === 'codex' && looksLikeProviderModel) {
    return `REVIEW_AGENT=codex expects a bare model name ` +
      `(e.g. "gpt-5.5", "gpt-5.2-codex"), but CODEX_MODEL looks like a provider/model: "${model}"`;
  }
  return null;
}
