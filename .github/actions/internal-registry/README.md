# Internal registry actions

Two composite actions that let a GitHub Actions job talk to the internal npm
registry without a static token. The job's own OIDC identity is exchanged for a
short-lived credential, per run.

| action | what it does |
| --- | --- |
| [`auth`](./auth) | Mints the credential. Optionally writes it into the npm user config so later `install` / `publish` steps just work. |
| [`dependency-check`](./dependency-check) | Asserts every version pinned in a lockfile is actually served by the registry. |

Both are versioned with their own tags (`internal-registry-auth-v1`,
`internal-registry-dependency-check-v2`). Pin a tag — do not track `main`.

## Using it from another repository

They are public actions, so any repository in any organization can use them.

Read-only check:

```yaml
jobs:
  dependency-check:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write # required, and it must be set on the JOB
    steps:
      - uses: actions/checkout@v7
      - id: auth
        uses: facebook/lexical/.github/actions/internal-registry/auth@internal-registry-auth-v1
        with:
          write-npmrc: 'false'
          on-missing-oidc: skip
      - uses: facebook/lexical/.github/actions/internal-registry/dependency-check@internal-registry-dependency-check-v2
        with:
          token: ${{ steps.auth.outputs.token }}
```

Installing or publishing scoped packages:

```yaml
      - uses: actions/setup-node@v6 # BEFORE auth: setup-node rewrites the npm config
        with:
          node-version: '24'
      - uses: facebook/lexical/.github/actions/internal-registry/auth@internal-registry-auth-v1
        with:
          scopes: '@acme @acme-ui'
      - run: npm publish
```

## Things that will bite you

- **`permissions: id-token: write` must be on the job.** A job-level
  `permissions` block *replaces* the workflow-level one rather than merging
  with it, so setting it only at the workflow level leaves the job with no
  OIDC identity.
- **Run `actions/setup-node` before `auth`, not after.** When `setup-node` is
  given a `registry-url` it rewrites the npm user config, which would discard
  what `auth` wrote.
- **`auth` writes *user* config, not a project-local `.npmrc`.** npm does not
  walk up from the directory it publishes from, so a repo-root `.npmrc` is
  invisible to `npm publish` run in a subdirectory. This is the usual cause of
  a confusing `ENEEDAUTH` when the credential is demonstrably present.
- **The two actions compose in the workflow; they do not nest.** A local
  `uses: ./...` inside a composite action resolves against the *caller's*
  workspace, not the repository the action came from, so a remote composite
  action cannot reference a sibling. This is why `dependency-check` takes a
  `token` input instead of calling `auth` itself.
- **Fork pull requests have no OIDC identity.** Use `on-missing-oidc: skip` and
  gate on a required `merge_group` run.

## Diagnosing a rejected credential

`auth` logs the OIDC subject it minted for:

```
Credential minted for subject: repo:my-org/my-repo:ref:refs/heads/main
```

That string is what the registry authorizes against, so quote it when asking
for access. It is not a secret; the credential itself is masked. Note that some
repositories are configured to emit an immutable subject that embeds numeric
IDs (`repo:my-org@123/my-repo@456:...`) — check with:

```bash
gh api repos/<owner>/<repo>/actions/oidc/customization/sub
```
