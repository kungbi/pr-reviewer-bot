import { buildAgentInvocation, modelAgentMismatch } from '../src/utils/agent-command';

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

  describe('codex', () => {
    it('uses `codex exec`, passes the model, bypasses sandbox, and delivers the prompt as a positional arg', () => {
      const inv = buildAgentInvocation(PROMPT, 'codex', 'gpt-5.2-codex');

      expect(inv.command).toBe('codex');
      expect(inv.args).toEqual([
        'exec',
        '--model',
        'gpt-5.2-codex',
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
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
        PROMPT,
      ]);
      expect(inv.args).not.toContain('--model');
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
