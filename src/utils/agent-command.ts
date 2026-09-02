/**
 * agent-command — build the spawn command/args for the configured review agent.
 *
 * Pure (no config / no side effects) so it can be unit-tested in isolation.
 * Four agents are supported:
 *   - claude   : `claude -p [--model <alias>] --dangerously-skip-permissions`
 *                prompt delivered via stdin.
 *   - opencode : `opencode run [--model <provider/model>] --dangerously-skip-permissions <prompt>`
 *                prompt delivered as a positional argument.
 *   - codex    : `codex exec --json [--model <name>] --dangerously-bypass-approvals-and-sandbox
 *                 --skip-git-repo-check <prompt>`
 *                prompt delivered as a positional argument.
 *   - hermes   : `hermes --profile <profile> chat -Q -t terminal -q <prompt>`
 *                prompt delivered as a query. The profile owns provider auth and
 *                the terminal/backend policy; only terminal tools are exposed.
 */

export type ReviewAgent = 'claude' | 'opencode' | 'codex' | 'hermes';

/**
 * The work Hermes profile executes terminal tools on its SSH backend, so the
 * bot's local /tmp clone is not visible there. Hermes reviews through its
 * authenticated remote `gh` read-only path instead.
 */
export function shouldUseLocalClone(agent: ReviewAgent): boolean {
  return agent !== 'hermes';
}

export interface AgentInvocation {
  command: string;
  args: string[];
  // When true, the prompt must be written to the process stdin.
  // When false, the prompt is already embedded in `args` as a positional arg.
  promptViaStdin: boolean;
}

export function buildAgentSpawnPath(basePath: string | undefined, home: string | undefined): string | undefined {
  if (!home) return basePath;

  const extraBins = [
    // Prefer the independently updated Codex CLI over nvm-global copies.
    // PM2 otherwise reaches an older global install that may reject new models.
    `${home}/.local/bin`,
    `${home}/.nvm/versions/node/v24.15.0/bin`,
    `${home}/.nvm/versions/node/v22.14.0/bin`,
    '/opt/homebrew/bin',
  ];
  const parts = (basePath ?? '').split(':').filter(Boolean);
  for (const bin of extraBins.reverse()) {
    const index = parts.indexOf(bin);
    if (index >= 0) parts.splice(index, 1);
    parts.unshift(bin);
  }
  return parts.join(':');
}

export function buildAgentInvocation(
  prompt: string,
  agent: ReviewAgent,
  model: string | null,
  codexReasoningEffort: string | null = null,
  hermesProfile = 'work',
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

  if (agent === 'hermes') {
    return {
      command: 'hermes',
      args: ['--profile', hermesProfile, 'chat', '-Q', '-t', 'terminal', '-q', prompt],
      promptViaStdin: false,
    };
  }

  if (agent === 'codex') {
    return {
      command: 'codex',
      args: [
        'exec',
        '--json',
        ...(model ? ['--model', model] : []),
        ...(codexReasoningEffort ? ['-c', `model_reasoning_effort="${codexReasoningEffort}"`] : []),
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
