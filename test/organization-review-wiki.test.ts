import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadOrganizationReviewWiki } from '../src/review-memory/organization-review-wiki';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'organization-review-wiki-'));
}

describe('loadOrganizationReviewWiki', () => {
  let dir: string;
  let wikiDirectory: string;

  beforeEach(() => {
    dir = tmpDir();
    wikiDirectory = path.join(dir, 'review-wiki');
    fs.mkdirSync(wikiDirectory, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('loads the full GitHub-backed wiki page for the reviewed organization', () => {
    fs.writeFileSync(path.join(wikiDirectory, 'kungbi.md'), `---
owner: kungbi
---
# Kungbi review conventions

- Check public API consumers before changing shared contracts.
- Treat deployment-specific exceptions as scoped, not global.
`);

    expect(loadOrganizationReviewWiki({ owner: 'kungbi', wikiDirectory })).toEqual({
      owner: 'kungbi',
      sourcePath: path.join(wikiDirectory, 'kungbi.md'),
      content: '# Kungbi review conventions\n\n- Check public API consumers before changing shared contracts.\n- Treat deployment-specific exceptions as scoped, not global.',
    });
  });

  it('fails closed when the page owner does not match the reviewed organization', () => {
    fs.writeFileSync(path.join(wikiDirectory, 'kungbi.md'), `---
owner: another-org
---
# Wrong page
`);

    expect(loadOrganizationReviewWiki({ owner: 'kungbi', wikiDirectory })).toBeUndefined();
  });

  it('rejects an invalid GitHub owner before it can affect the file path', () => {
    expect(loadOrganizationReviewWiki({ owner: '../another-org', wikiDirectory })).toBeUndefined();
  });
});
