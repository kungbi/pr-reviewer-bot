# Trusted images for isolated review tests

The runner has no default trusted images. An operator must independently verify the image provenance, platform, and exact Node version against an authoritative source, make the verified image available locally, and configure its full local Docker **image ID**. A tag, registry manifest digest, or `docker image inspect` alone does not establish provenance. Never take this mapping from a PR or an untrusted repository. No production image is asserted by this project.

Set the operator-controlled process environment variable `REVIEW_TRUSTED_NODE_IMAGES` to a flat JSON object, for example (replace the placeholder with the verified 64-character lowercase image ID):

```text
{"22.23.0":"sha256:<64 lowercase hex characters>"}
```

Keys must be exact canonical `major.minor.patch` versions (no `v`, range, or leading zeroes). Values must be full lowercase `sha256:` image IDs. Duplicate versions, invalid JSON, tags, uppercase IDs, and malformed entries fail startup. Unset means an empty mapping: tests are blocked before Docker. A missing version or unavailable/mismatched local image also blocks execution; the runner never pulls images. The operator is responsible for installing and updating verified images and for protecting the process configuration.

The image must support the runner's Linux tools, `npm`, and non-root UID 1000. The install uses `npm ci --ignore-scripts` with bridge networking; the test only runs after network disconnection is verified. Because install scripts are suppressed, even successful stages are reported as **inconclusive/blocked**, not as a full-fidelity pass. This sandbox does not make arbitrary untrusted code risk-free; operate it on a suitably isolated host.
