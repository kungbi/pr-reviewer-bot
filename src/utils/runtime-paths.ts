import path from 'node:path';

/** Mutable data belongs to the operator's runtime, never the installed release.
 * Defaults preserve the existing cwd/state deployment. Set an absolute runtime
 * root to keep the same data when launching from another working directory.
 */
export function runtimeStatePath(...segments: string[]): string {
  const root = process.env.PR_REVIEWER_RUNTIME_ROOT;
  if (root !== undefined && (!root.trim() || !path.isAbsolute(root))) {
    throw new Error('PR_REVIEWER_RUNTIME_ROOT must be an absolute directory');
  }
  return path.join(root ?? process.cwd(), 'state', ...segments);
}
