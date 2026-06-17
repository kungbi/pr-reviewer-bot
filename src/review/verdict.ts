/**
 * verdict — extract the review verdict from a review agent's stdout.
 *
 * Uses the LAST `VERDICT:` occurrence, not the first. codex (`codex exec`) echoes
 * the user prompt back to stdout, and our review prompt contains an instruction
 * line listing all three tokens ("VERDICT: APPROVED | VERDICT: NEEDS_WORK |
 * VERDICT: BLOCKED"). The agent's real verdict is always emitted as the final
 * line, so the last match is the authoritative one. This is also safe for
 * claude/opencode, which emit the verdict only once (last === only).
 */
import { ReviewVerdict } from '../types';

export function extractVerdict(output: string): ReviewVerdict {
  const matches = [...output.matchAll(/VERDICT:\s*(APPROVED|NEEDS_WORK|BLOCKED)/gi)];
  if (matches.length === 0) return 'reviewed';

  const token = matches[matches.length - 1][1].toUpperCase();
  if (token === 'APPROVED')   return 'approved';
  if (token === 'NEEDS_WORK') return 'needs_work';
  if (token === 'BLOCKED')    return 'blocked';
  return 'reviewed';
}
