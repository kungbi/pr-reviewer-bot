import { publicationErrorDiagnostic } from '../src/review/publication-error-diagnostic';

describe('publication error diagnostics', () => {
  it('retains bounded single-line error context, not raw HTTP objects or stacks', () => {
    const raw = Object.assign(new Error('lookup failed\nforged\u001b[31m ' + 'x'.repeat(5000)), { code: 'ECONNRESET', response: { status: 503, data: 'private body' }, config: { headers: { authorization: 'private' } } });
    const diagnostic = publicationErrorDiagnostic(raw);
    expect(diagnostic).toEqual({ name: 'Error', message: expect.stringContaining('lookup failed'), code: 'ECONNRESET', status: 503 });
    expect(diagnostic.message.length).toBeLessThanOrEqual(1000);
    expect(JSON.stringify(diagnostic)).not.toMatch(/private|stack|config|\\n|\\u001b/);
  });

  it.each([
    'Bearer private-value', 'Authorization: token private-value',
    'password="private value"', '"access_token": "private-value"',
    'https://user:private-value@example.invalid/path?key=private-value',
    'https://example.invalid/path?token=private-value',
    'ghp_' + 'a'.repeat(30), 'github_pat_' + 'b'.repeat(40),
    'https://discord.com/api/webhooks/123/private-value',
  ])('redacts credential-bearing diagnostic text: %s', text => {
    const diagnostic = publicationErrorDiagnostic(new Error(`request failed: ${text}`));
    expect(diagnostic.message).toContain('request failed');
    expect(diagnostic.message).not.toContain('private');
    expect(diagnostic.message).not.toContain('a'.repeat(30));
    expect(diagnostic.message).not.toContain('b'.repeat(40));
  });

  it('does not stringify arbitrary thrown objects or retain untrusted metadata', () => {
    expect(publicationErrorDiagnostic({ secret: 'private', toString() { throw new Error('no'); } })).toEqual({ name: 'Error', message: 'Non-Error publication failure' });
    expect(publicationErrorDiagnostic('timeout')).toEqual({ name: 'Error', message: 'timeout' });
    expect(publicationErrorDiagnostic(Object.assign(new Error('failure'), { name: 'private name', code: 'private value', status: 'private' }))).toEqual({ name: 'Error', message: 'failure' });
  });
});
