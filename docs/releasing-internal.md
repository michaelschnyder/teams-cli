# Internal release operations

GitHub remains authoritative. `.gitlab-ci.yml` runs in the internal `teams-cli` project only for scheduled or manually started pipelines on protected `main`. Native GitLab synchronization is not used. The entire job is serialized by `teams-cli-internal-distribution`.

## Bootstrap

1. Merge and publish the distribution-aware implementation through the existing public workflow. Set the resulting stable version as the minimum below. Do not import older packages with a public-only updater.
2. Create the internal project in `INTERNAL_GROUP` without an initial README or unrelated commit. Seed its main branch once from the released GitHub source. This makes the shared `.gitlab-ci.yml` available; the first run copies the selected stable release tags. Subsequent application and pipeline changes go through GitHub only.
3. Protect main and `v*` release tags. Allow the synchronization project token's bot to push the selected refs; deny force pushes and direct application development internally.
4. Assign a Linux Docker-executor runner capable of the supplied Docker-in-Docker service. The runner must support privileged service containers and an isolated per-job network. The unauthenticated Docker service port is confined to that job network; never expose it outside the runner. The Node job image contains Git; the job installs its Docker client. Run the unprivileged smoke container without host mounts or forwarded credentials.
5. Configure the variables below, disable npm forwarding to npmjs.org for the internal group, and complete the team's employee registry bootstrap.
6. Validate `.gitlab-ci.yml` through the Code Hub CI linter, then run the pipeline in a disposable internal project. Verify source refs, package contents, receipt recovery, and installation before using the production project.
7. Run production promotion manually. Test an upgrade between two eligible public releases before enabling a five-minute GitLab schedule targeting protected main. Select a durable internal schedule owner and configure GitLab failed-pipeline notifications for maintainers. The schedule remains subject to instance frequency limits and runner availability.

No script automatically creates projects, tokens, schedules, or public releases. These deployment actions need the team's actual endpoint/project values and an authenticated Code Hub session.

For the initial seed, replace `CODE_HUB` and `INTERNAL_GROUP` with the configured host and project namespace. Use Git's normal authenticated HTTPS flow; the destination URL contains no token:

```console
git clone --branch main --single-branch https://github.com/michaelschnyder/teams-cli.git teams-cli-bootstrap
cd teams-cli-bootstrap
git push https://CODE_HUB/INTERNAL_GROUP/teams-cli.git refs/heads/main:refs/heads/main
```

## Variables and access

| Variable | Configuration |
| --- | --- |
| `INTERNAL_NPM_PACKAGE` | Set to the organization’s scoped package name, for example `@internal/teams-cli`. |
| `INTERNAL_NPM_REGISTRY` | Required HTTPS employee installation endpoint. Embed the same endpoint used by the company's user/global scope configuration; it may differ from the project publication endpoint. |
| `PROMOTION_MIN_VERSION` | Required first stable version containing distribution-aware updates. Older versions are never imported. |
| `SYNC_TOKEN` | Protected, masked project access token with `write_repository`, with permission to push protected main and create stable tags. Track its expiry and rotation. |
| `PROMOTION_SMOKE_IMAGE` | Defaults to `node:24-bookworm`. An approved equivalent must contain Node, npm, sh, and tar; pin an image digest through this variable if required by the runner policy. |
| `CI_JOB_TOKEN` | Supplied by GitLab; authenticates package publication, readback, and generic promotion receipts within this project. |

Publication endpoints derive from `CI_API_V4_URL` and `CI_PROJECT_ID`. Git destinations derive from `CI_PROJECT_URL`. No credentials appear in Git remote URLs; Git askpass supplies the synchronization credential only for the internal host. npm uses an ephemeral authentication file. GitLab supplies the pipeline URL for receipts.

Required outbound destinations are GitHub's repository and API, npmjs.org, Sigstore trust metadata services, Code Hub, and the smoke image/dependency registries. Container preparation receives only the tarball and trusted installation test script and downloads dependencies with all lifecycle scripts disabled. The prepared image then runs the CLI with networking disabled, preventing access to the runner service network as well. Neither phase receives a host workspace, Docker socket, npm authentication file, or GitLab environment. Temporary preparation containers/images are removed after the check.

## Run behavior

Every run synchronizes full upstream main history and stable `vX.Y.Z` tags, including source changes between releases. Existing internal refs outside this selection are preserved. Diverged main or rewritten tags fail without overwriting them. The checked-out pipeline/scripts remain fixed for the running job; updated main applies to the next scheduled run.

The promotion job compares version inventories, imports missing eligible stable releases, and repairs incomplete receipts/channel updates. It rejects deprecated versions, prereleases, missing releases, mismatched source commits, unsafe archives, and invalid provenance. It verifies the public Sigstore certificate's GitHub issuer and exact publication workflow/tag identity, and binds the signed statement to the tarball digest and mirrored commit.

Only package identity, distribution/publication metadata, and the installation examples in an explicit document allowlist are transformed. Compiled files and dependencies remain unchanged. The input's public provenance is preserved as verification evidence; it is not represented as a signature of the renamed archive.

Each version is uploaded with `promotion-VERSION`, read back, and associated with a durable receipt at:

```text
/api/v4/projects/PROJECT_ID/packages/generic/teams-cli-promotions/VERSION/promotion.json
```

The receipt includes both archive digests, the source commit, transformation revision, and promotion pipeline. After completed verification, the job advances `latest` without moving backward and removes its staging tag. Do not allow competing manual publishers or apply cleanup rules to these packages/receipts. GitLab serialization covers this pipeline, not unrelated external publishers.

## Recovery and diagnostics

- A successful run with no differences is quiet. Failed runs report sanitized configuration, synchronization, or verification errors; raw child output and credential-bearing HTTP details are withheld.
- Retry the scheduled pipeline manually or wait for its next run. Existing matching releases are not published again. If an upload completed but its receipt/tag update failed, the job verifies the existing archive and finishes those steps.
- On ref divergence, investigate the internal edits/upstream tag rewrite. The job does not force a repair or delete anything.
- On authentication failure, check schedule ownership, token expiry, protected-ref permissions, package access, and employee registry settings. Do not paste tokens into job logs.
- A conflicting artifact or receipt requires maintainer investigation. Never overwrite or delete a published version to make promotion pass. Publish a new upstream version for changed package bytes or a packaging correction.
- A backward change to public `latest` is not automatically applied internally. Rollback is a separate explicit maintainer operation.

## Verification commands

```console
npm run check
npm test
npm run build
npm audit --omit=dev --audit-level=high
npm run package:check
npm run package:smoke
npm run package:distributions
```

Both package variants run through the existing Ubuntu, macOS, and Windows GitHub verification matrix. `package:check` and `package:smoke` also accept an existing tarball path after `--`. Offline tests cover explicit Git synchronization, authenticated registry reads, denied writes, byte preservation, and retry boundaries. Live Teams tenant tests are unnecessary for this feature.
