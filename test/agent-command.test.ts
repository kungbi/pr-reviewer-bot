import { buildAgentInvocation, buildAgentSpawnPath, modelAgentMismatch, shouldUseLocalClone } from '../src/utils/agent-command';

describe('buildAgentSpawnPath', () => {
  it('prefers the current local Codex CLI before stale nvm installations', () => {
    const pathValue = buildAgentSpawnPath('/usr/bin:/bin:/Users/me/.nvm/versions/node/v24.15.0/bin', '/Users/me');

    expect(pathValue?.split(':').slice(0, 4)).toEqual([
      '/Users/me/.local/bin',
      '/Users/me/.nvm/versions/node/v24.15.0/bin',
      '/Users/me/.nvm/versions/node/v22.14.0/bin',
      '/opt/homebrew/bin',
    ]);
    expect(pathValue?.split(':').filter((part) => part === '/Users/me/.nvm/versions/node/v24.15.0/bin')).toHaveLength(1);
  });

  it('returns the original PATH when HOME is unavailable', () => {
    expect(buildAgentSpawnPath('/usr/bin:/bin', undefined)).toBe('/usr/bin:/bin');
  });
});

describe('local clone policy', () => {
  it('keeps local clones for standalone agents but uses GitHub read mode for Hermes', () => {
    expect(shouldUseLocalClone('codex')).toBe(true);
    expect(shouldUseLocalClone('hermes')).toBe(false);
  });
});

describe('buildAgentInvocation', () => {
  const PROMPT = 'review this PR';

  describe('claude', () => {
    it('uses `claude -p`, passes the model, and delivers the prompt via stdin', () => {
      const inv = buildAgentInvocation(PROMPT, 'claude', 'opus');

      expect(inv.command).toBe('claude');
      expect(inv.args).toEqual(['-p', '--model', 'opus', '--dangerously-skip-permissions']);
      expect(inv.promptViaStdin).toBe(true);
      // prompt must NOT be an argv entry for claude
      expect(inv.args).not.toContain(PROMPT);
    });

    it('omits the --model flag when model is null', () => {
      const inv = buildAgentInvocation(PROMPT, 'claude', null);

      expect(inv.args).toEqual(['-p', '--dangerously-skip-permissions']);
      expect(inv.args).not.toContain('--model');
    });
  });

  describe('opencode', () => {
    it('uses `opencode run`, passes the model, and delivers the prompt as a positional arg', () => {
      const inv = buildAgentInvocation(PROMPT, 'opencode', 'anthropic/claude-opus-4-5');

      expect(inv.command).toBe('opencode');
      expect(inv.args).toEqual([
        'run',
        '--model',
        'anthropic/claude-opus-4-5',
        '--dangerously-skip-permissions',
        PROMPT,
      ]);
      expect(inv.promptViaStdin).toBe(false);
      // prompt is the final positional argument
      expect(inv.args[inv.args.length - 1]).toBe(PROMPT);
    });

    it('omits the --model flag when model is null (uses opencode default)', () => {
      const inv = buildAgentInvocation(PROMPT, 'opencode', null);

      expect(inv.args).toEqual(['run', '--dangerously-skip-permissions', PROMPT]);
      expect(inv.args).not.toContain('--model');
    });
  });

  describe('hermes', () => {
    it('runs a fresh work-profile Hermes chat and delivers the prompt as a query', () => {
      const inv = buildAgentInvocation(PROMPT, 'hermes', null, null, 'work');

      expect(inv.command).toBe('hermes');
      expect(inv.args).toEqual([
        '--profile', 'work',
        'chat', '-Q', '-t', 'terminal', '-q', PROMPT,
      ]);
      expect(inv.promptViaStdin).toBe(false);
      expect(inv.args[inv.args.length - 1]).toBe(PROMPT);
    });
  });

  describe('codex', () => {
    it('uses `codex exec`, passes the model and reasoning effort, bypasses sandbox, and delivers the prompt as a positional arg', () => {
      const inv = buildAgentInvocation(PROMPT, 'codex', 'gpt-5.2-codex', 'xhigh');

      expect(inv.command).toBe('codex');
      expect(inv.args).toEqual([
        'exec',
        '--json',
        '--model',
        'gpt-5.2-codex',
        '-c',
        'model_reasoning_effort="xhigh"',
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
        PROMPT,
      ]);
      expect(inv.promptViaStdin).toBe(false);
      expect(inv.args[inv.args.length - 1]).toBe(PROMPT);
    });

    it('omits the --model flag when model is null (uses codex default)', () => {
      const inv = buildAgentInvocation(PROMPT, 'codex', null);

      expect(inv.args).toEqual([
        'exec',
        '--json',
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
        PROMPT,
      ]);
      expect(inv.args).not.toContain('--model');
      expect(inv.args).not.toContain('model_reasoning_effort="xhigh"');
    });
  });
});

describe('modelAgentMismatch', () => {
  it('returns null when model is null (agent uses its own default)', () => {
    expect(modelAgentMismatch('claude', null)).toBeNull();
    expect(modelAgentMismatch('opencode', null)).toBeNull();
  });

  it('accepts a short alias for claude', () => {
    expect(modelAgentMismatch('claude', 'opus')).toBeNull();
    expect(modelAgentMismatch('claude', 'sonnet')).toBeNull();
  });

  it('accepts a provider/model for opencode', () => {
    expect(modelAgentMismatch('opencode', 'google/gemini-2.5-flash')).toBeNull();
    expect(modelAgentMismatch('opencode', 'openai/gpt-5.2-codex')).toBeNull();
  });

  it('accepts a bare model name for codex', () => {
    expect(modelAgentMismatch('codex', 'gpt-5.5')).toBeNull();
    expect(modelAgentMismatch('codex', 'gpt-5.2-codex')).toBeNull();
  });

  it('rejects a claude alias passed to opencode', () => {
    const msg = modelAgentMismatch('opencode', 'opus');
    expect(msg).not.toBeNull();
    expect(msg).toContain('provider/model');
  });

  it('rejects a provider/model passed to claude', () => {
    const msg = modelAgentMismatch('claude', 'openai/gpt-5.2-codex');
    expect(msg).not.toBeNull();
    expect(msg).toContain('alias');
  });

  it('rejects a provider/model passed to codex', () => {
    const msg = modelAgentMismatch('codex', 'openai/gpt-5.2-codex');
    expect(msg).not.toBeNull();
    expect(msg).toContain('bare model name');
  });
});
