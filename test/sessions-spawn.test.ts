import { buildReviewAgentEnvironment } from '../src/utils/sessions_spawn';
import * as sessionsSpawnModule from '../src/utils/sessions_spawn';

const parseCodexExecJsonl = (sessionsSpawnModule as typeof sessionsSpawnModule & {
  parseCodexExecJsonl: (output: string) => string;
}).parseCodexExecJsonl;

describe('buildReviewAgentEnvironment', () => {
  it('does not pass local GitHub write credentials to a review agent child process', () => {
    const parentEnvironment = {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/bot',
      GH_TOKEN: 'local-write-token',
      GITHUB_TOKEN: 'another-write-token',
      GITHUB_PAT: 'pat-token',
      GH_ENTERPRISE_TOKEN: 'enterprise-token',
      SAFE_SETTING: 'retained',
    };

    const childEnvironment = buildReviewAgentEnvironment(parentEnvironment);

    expect(childEnvironment).toMatchObject({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/bot',
      SAFE_SETTING: 'retained',
    });
    expect(childEnvironment.GH_TOKEN).toBeUndefined();
    expect(childEnvironment.GITHUB_TOKEN).toBeUndefined();
    expect(childEnvironment.GITHUB_PAT).toBeUndefined();
    expect(childEnvironment.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(parentEnvironment.GH_TOKEN).toBe('local-write-token');
  });
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
