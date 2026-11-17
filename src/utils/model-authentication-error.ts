/** A fixed, non-provider diagnostic safe for logs, state and operator alerts. */
export class ModelAuthenticationError extends Error {
  readonly code = 'provider_authentication_failed';

  constructor() {
    super('Review provider authentication failed; operator reauthentication required.');
    this.name = 'ModelAuthenticationError';
  }
}

const AUTH_FAILURE = /refresh[_ -]?token|refresh401|401\s+Unauthorized|authentication (?:failed|error)|not (?:logged|signed) in/i;

/** Classify before truncating/rewriting errors; never retain raw errors/causes. */
export function modelAuthenticationError(error: unknown): ModelAuthenticationError | null {
  if (error instanceof ModelAuthenticationError) return new ModelAuthenticationError();
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return AUTH_FAILURE.test(message) ? new ModelAuthenticationError() : null;
}
