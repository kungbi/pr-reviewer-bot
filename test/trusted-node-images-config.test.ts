describe('trusted Node image operator configuration', () => {
  const previous = process.env.REVIEW_TRUSTED_NODE_IMAGES;
  afterEach(() => {
    if (previous === undefined) delete process.env.REVIEW_TRUSTED_NODE_IMAGES;
    else process.env.REVIEW_TRUSTED_NODE_IMAGES = previous;
  });
  function load(raw?: string) {
    if (raw === undefined) delete process.env.REVIEW_TRUSTED_NODE_IMAGES;
    else process.env.REVIEW_TRUSTED_NODE_IMAGES = raw;
    let config: any;
    jest.isolateModules(() => { config = require('../src/utils/config').default; });
    return config.trustedNodeImages;
  }
  it('defaults to no trusted images', () => expect(load()).toEqual({}));
  it('accepts exact versions mapped to immutable image IDs', () => {
    const mapping = { '20.11.1': `sha256:${'a'.repeat(64)}` };
    expect(load(JSON.stringify(mapping))).toEqual(mapping);
  });
  it.each(['', 'null', '[]', '{', '{"v20.11.1":"sha256:abc"}', '{"20.11.1":"node:latest"}', `{ "20.11.1": "sha256:${'A'.repeat(64)}" }`, `{ "01.2.3": "sha256:${'a'.repeat(64)}" }`, `{ "20.11.1": "sha256:${'a'.repeat(64)}", "20.11.1": "sha256:${'b'.repeat(64)}" }`])('rejects malformed mapping %s', raw => {
    expect(() => load(raw)).toThrow(/REVIEW_TRUSTED_NODE_IMAGES/);
  });
});
