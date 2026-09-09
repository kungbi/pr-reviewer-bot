import { buildReviewAgentEnvironment } from '../src/utils/sessions_spawn';
import * as sessionsSpawnModule from '../src/utils/sessions_spawn';

const parseCodexExecJsonl = (sessionsSpawnModule as typeof sessionsSpawnModule & {
  parseCodexExecJsonl: (output: string) => string;
}).parseCodexExecJsonl;

describe('buildReviewAgentEnvironment', () => {
  it('passes the canonical GH_TOKEN only to Codex while removing credential aliases', () => {
    const parentEnvironment = {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/bot',
      GH_TOKEN: 'shared-review-token',
      GITHUB_TOKEN: 'another-write-token',
      GITHUB_PAT: 'pat-token',
      GH_ENTERPRISE_TOKEN: 'enterprise-token',
      GITHUB_ENTERPRISE_TOKEN: 'github-enterprise-token',
      SAFE_SETTING: 'retained',
    };

    const childEnvironment = buildReviewAgentEnvironment(parentEnvironment, 'codex');

    expect(childEnvironment).toMatchObject({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/bot',
      GH_TOKEN: 'shared-review-token',
      SAFE_SETTING: 'retained',
    });
    expect(childEnvironment.GITHUB_TOKEN).toBeUndefined();
    expect(childEnvironment.GITHUB_PAT).toBeUndefined();
    expect(childEnvironment.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(childEnvironment.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
    expect(parentEnvironment.GH_TOKEN).toBe('shared-review-token');
  });

  it.each(['claude', 'opencode', 'hermes'] as const)(
    'does not pass GH_TOKEN to the %s review agent',
    (agent) => {
      const childEnvironment = buildReviewAgentEnvironment(
        { GH_TOKEN: 'shared-review-token', SAFE_SETTING: 'retained' },
        agent,
      );

      expect(childEnvironment.GH_TOKEN).toBeUndefined();
      expect(childEnvironment.SAFE_SETTING).toBe('retained');
    },
  );
});

describe('parseCodexExecJsonl', () => {
  it('returns only the final Codex agent message from a successful JSONL stream', () => {
    const output = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'non-fatal warning' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"summary":"verified"}' } }),
      JSON.stringify({ type: 'turn.completed', usage: { output_tokens: 12 } }),
    ].join('\n');

    expect(parseCodexExecJsonl(output)).toBe('{"summary":"verified"}');
  });

  it('classifies a structured server_overloaded terminal event as capacity failure', () => {
    const output = JSON.stringify({
      type: 'turn.failed',
      error: { code: 'server_overloaded', message: 'Selected model is at capacity' },
    });

    expect(() => parseCodexExecJsonl(output)).toThrow('server_overloaded');
  });

  it('does not mistake an ordinary command output for a capacity terminal error', () => {
    const output = [
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', aggregated_output: 'grep found server_overloaded in fixture data' },
      }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"summary":"verified"}' } }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n');

    expect(parseCodexExecJsonl(output)).toBe('{"summary":"verified"}');
  });
});
