/**
 * Types for repo-clone based PR review flow.
 */

export type CloneFailureReason =
  | 'git_not_found'
  | 'auth_failed'
  | 'timeout'
  | 'ref_missing'
  | 'depth_insufficient'
  | 'unknown';

export type CloneResult =
  | { ok: true; path: string }
  | { ok: false; reason: CloneFailureReason };
