import { extractVerdict } from '../src/review/verdict';

describe('extractVerdict', () => {
  it('returns "reviewed" when no VERDICT line is present', () => {
    expect(extractVerdict('some output with no verdict')).toBe('reviewed');
  });

  it('maps each token to its verdict', () => {
    expect(extractVerdict('VERDICT: APPROVED')).toBe('approved');
    expect(extractVerdict('VERDICT: NEEDS_WORK')).toBe('needs_work');
    expect(extractVerdict('VERDICT: BLOCKED')).toBe('blocked');
  });

  it('is case-insensitive', () => {
    expect(extractVerdict('verdict: blocked')).toBe('blocked');
  });

  // The key codex case: the agent echoes the prompt (which lists all three
  // tokens as instructions) before emitting its real verdict last.
  it('uses the LAST verdict when the prompt is echoed before the real one', () => {
    const codexOutput = [
      'user',
      'Post the review, then output exactly one line:',
      '`VERDICT: APPROVED` | `VERDICT: NEEDS_WORK` | `VERDICT: BLOCKED`',
      'codex',
      'VERDICT: BLOCKED',
      'tokens used',
      '25,707',
    ].join('\n');

    expect(extractVerdict(codexOutput)).toBe('blocked');
  });

  it('still works when the real verdict is APPROVED after an echoed instruction', () => {
    const codexOutput = [
      'instruction: VERDICT: APPROVED | VERDICT: NEEDS_WORK | VERDICT: BLOCKED',
      'codex',
      'VERDICT: APPROVED',
    ].join('\n');

    expect(extractVerdict(codexOutput)).toBe('approved');
  });
});
