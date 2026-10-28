export interface PublicationErrorDiagnostic {
  name: string;
  message: string;
  code?: string;
  status?: number;
}

/** Never retain an Axios error/cause: it can contain headers, bodies and tokens. */
export function publicationErrorDiagnostic(error: unknown): PublicationErrorDiagnostic {
  const source = error instanceof Error ? error as Error & { code?: unknown; status?: unknown; response?: { status?: unknown } } : undefined;
  const raw = source?.message ?? (typeof error === 'string' ? error : 'Non-Error publication failure');
  const message = raw
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|npm_[A-Za-z0-9]+|xox[a-z]-[A-Za-z0-9-]+)/g, '[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
    // URLs may carry userinfo, webhook credentials, signed queries or path tokens.
    .replace(/https?:\/\/[^\s<>"']+/gi, '[REDACTED_URL]')
    .replace(/\b(?:Bearer|Basic|token)\s+[^\s,;]+/gi, '[REDACTED_AUTH]')
    .replace(/["']?\b(?:_authToken|authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret|token)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '[REDACTED]')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .slice(0, 1000);
  const diagnostic: PublicationErrorDiagnostic = {
    name: source && /^[A-Za-z][A-Za-z0-9]*Error$|^Error$/.test(source.name) && source.name.length <= 80 ? source.name : 'Error',
    message,
  };
  if (typeof source?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(source.code)) diagnostic.code = source.code;
  const status = source?.status ?? source?.response?.status;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) diagnostic.status = status;
  return diagnostic;
}

export function publicationDiagnosticText(diagnostic: PublicationErrorDiagnostic): string {
  return `${diagnostic.name}${diagnostic.code ? ` [${diagnostic.code}]` : ''}${diagnostic.status ? ` (HTTP ${diagnostic.status})` : ''}: ${diagnostic.message}`;
}
