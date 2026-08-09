# Signed Release Controls and Staged Publication

## Decision

Keep versioned binaries on GitHub Releases. Build each stable or nightly release
as a draft, check every asset, publish it once, and enable GitHub release
immutability. Add a small, separately served, independently signed policy
document for rollout, pause, and bad-version controls.

GitHub Releases and `electron-updater` do not provide the full control plane
required by [decision map #1091](https://github.com/Mzeey-Empire/mcode/issues/1091)
and [research issue #1093](https://github.com/Mzeey-Empire/mcode/issues/1093).
GitHub can protect complete release assets. It cannot give an immutable release
a later pause, denylist, or rollout change. `electron-updater` can select a
percentage locally, but its metadata is unsigned and version 6.8.3 sends a
persistent staging identifier in an HTTP header.

## Verified current state

- Mcode defines **stable release** and **nightly release** as separate release
  channels. A superseded nightly has no rollback role
  ([`CONTEXT.md`](../../CONTEXT.md#release-channels)). Both channels must meet
  the same recovery guarantee in [#1091](https://github.com/Mzeey-Empire/mcode/issues/1091).
- The desktop package uses GitHub publishing and targets Windows NSIS and ZIP,
  macOS DMG and ZIP, and Linux AppImage and DEB. `bun.lock` resolves
  `electron-updater` 6.8.3 and `electron-builder` 25.1.8
  ([package](../../apps/desktop/package.json), [`bun.lock`](../../bun.lock)).
- The stable workflow starts on `release: published`, then uploads assets one
  at a time with `gh release upload --clobber`. The release is visible before
  its updater files are complete
  ([workflow](../../.github/workflows/build-release.yml)).
- The nightly workflow creates a draft, uploads all platform assets, requires
  `nightly.yml`, `nightly-linux.yml`, and `nightly-mac.yml`, then publishes the
  draft. This is the correct publication shape
  ([workflow](../../.github/workflows/nightly-desktop.yml)).
- The package and workflows contain no signing credentials or
  `forceCodeSigning` setting. Both workflows disable macOS identity discovery.
  This proves that signing is not wired in these files. It does not prove that
  every hosted artifact is unsigned
  ([package](../../apps/desktop/package.json), [stable workflow](../../.github/workflows/build-release.yml), [nightly workflow](../../.github/workflows/nightly-desktop.yml)).
- Mcode applies Drizzle migrations to the user's SQLite file during startup
  ([migration guide](../guides/db-migrations.md)). Release controls must work
  with candidate quarantine and preservation of the pre-update data copy.
- A read-only API check on 2026-08-09 reported that release immutability was
  disabled for this repository. GitHub documents the check endpoint and its
  `enabled` result
  ([API](https://docs.github.com/en/rest/repos/repos?apiVersion=2026-03-10#check-if-immutable-releases-are-enabled-for-a-repository)).

## Capability matrix

| Control | GitHub Releases and pinned updater | Fit | Separate capability |
| --- | --- | --- | --- |
| Artifact signing | `electron-builder` supports macOS signing and Windows Authenticode. macOS signing is required for automatic updates. NSIS 6.8.3 checks the downloaded EXE only when `publisherName` exists ([guide](https://www.electron.build/docs/features/auto-update/), [NSIS source](https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.3/packages/electron-updater/src/NsisUpdater.ts)). | Partial. Current CI does not wire signing. The pinned DEB updater uses `dpkg` and an `apt-get` fallback with `--allow-unauthenticated`, so it gives no comparable Linux guarantee ([source](https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.3/packages/electron-updater/src/DebUpdater.ts)). | Provision and protect platform signing keys. Require signing as a publication gate. |
| Client metadata verification | The updater parses `latest*.yml`, requires an artifact checksum, and checks the downloaded file against that checksum ([provider source](https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.3/packages/electron-updater/src/providers/Provider.ts), [download source](https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.3/packages/electron-updater/src/AppUpdater.ts)). | No metadata authenticity. An attacker who can replace both YAML and a binary can supply a matching checksum. The client does not verify GitHub's release attestation. | Sign the policy document with a release-policy key. Embed its public key in the client. |
| Atomic publication | GitHub recommends draft, upload, publish. Immutable releases then lock the tag and assets and create a release attestation ([GitHub](https://docs.github.com/en/enterprise-cloud@latest/code-security/concepts/supply-chain-security/immutable-releases)). | Partial. Publication gives one visibility boundary, but GitHub documents no transaction or compare-and-swap check across asset uploads. | Serialize each channel's publication and check the complete asset set before publication. No service is required for this gate. |
| Cohorts and staged rollout | `stagingPercentage` in `latest*.yml` selects a percentage ([guide](https://www.electron.build/docs/features/auto-update/#staged-rollouts)). Version 6.8.3 creates a persistent random `.updaterId` and computes membership locally, but also sends it as `x-user-staging-id` ([source](https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.3/packages/electron-updater/src/AppUpdater.ts#L370-L390)). | Partial. Local selection can avoid telemetry, but the pinned implementation discloses the identifier. Changing the percentage also conflicts with immutable release metadata. | Publish signed percentage and salt values. Compute membership only on the client. Do not transmit the local cohort identifier. |
| Pause | A GitHub Actions environment can gate publication. A mutable `stagingPercentage: 0` can stop new eligibility checks ([environment guide](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments), [release API](https://docs.github.com/en/rest/releases/releases)). | Inadequate after publication. These actions cannot recall a cached download. Immutable assets cannot accept a later YAML edit. | Add a signed `paused` state and require a fresh policy check before download and before install. |
| Bad-version blocking | The updater exposes `isUpdateSupported`, but its default checks only the minimum system version. Its staged-rollout guide tells publishers to ship a higher version after a bad release ([source](https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.3/packages/electron-updater/src/AppUpdater.ts#L397-L441), [guide](https://www.electron.build/docs/features/auto-update/#staged-rollouts)). | No denylist. Removing a release cannot stop an already downloaded installer or repair an installed version. | Add signed blocked versions or ranges. Delete a blocked cached candidate and reject it before activation. Keep local candidate quarantine after failed health checks. |

## GitHub and updater limits

GitHub asset uploads are separate requests. GitHub can leave a failed upload as
an empty `starter` asset, and a duplicate asset name returns `422`. The API does
not replace binary content in place
([asset API](https://docs.github.com/en/rest/releases/assets)). A publication job
must use one channel-specific lock and reject missing, duplicate, empty, or
non-`uploaded` assets. It must also check expected names, sizes, and digests.

GitHub's latest-release API excludes drafts and prereleases
([API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)).
This supports the stable channel, but it does not define a pause or block
record. The reviewed GitHub release API has no percentage, cohort, denylist, or
client-policy fields. This is an inference from the documented API surface.

`electron-updater` staged rollout requires edits to the channel YAML. That
design conflicts with immutable releases. Version 6.8.3 also treats a malformed
`stagingPercentage` as eligible for all users and does not clamp the value
([source](https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.3/packages/electron-updater/src/AppUpdater.ts#L370-L390)).
Publication must reject any percentage outside the integer range 0 through 100.

## Minimum separate control plane

The minimum control plane can be a signed static policy document on a separate
origin or object store. It does not need accounts, device registration, or
telemetry. One document per channel must contain:

- a monotonic sequence number, issue time, expiry time, and key identifier;
- the active candidate version and immutable GitHub artifact references;
- `paused`, rollout percentage, and a per-candidate cohort salt;
- blocked versions or bounded version ranges;
- the minimum client policy version and policy signature.

The client must keep a random local cohort identifier, verify the signature,
reject replayed or expired policy, and compute cohort membership locally. It
must never send that identifier. The policy publisher needs authenticated,
audited writes and compare-and-swap updates so two operators cannot overwrite a
newer pause or block decision.

## Security and race rules

1. Build all artifacts in a draft. Check platform signatures, names, sizes,
   digests, channel metadata, and smoke-test results before publication.
2. Publish the draft once. Enable release immutability so later policy changes
   cannot replace the approved binaries
   ([GitHub](https://docs.github.com/en/enterprise-cloud@latest/code-security/concepts/supply-chain-security/immutable-releases)).
3. Verify the signed policy before download and again immediately before
   install. The second check closes the download-to-install pause race. If a
   fresh policy is unavailable, do not auto-install a queued candidate.
4. Keep signing credentials separate from release-policy approval. A valid
   platform signature proves key control, not release quality. Use timestamps
   for Windows Authenticode
   ([Microsoft](https://learn.microsoft.com/en-us/windows/win32/seccrypto/time-stamping-authenticode-signatures)).
5. Keep failed candidates in local quarantine until a newer version appears or
   the user explicitly retries. A server pause must not clear that local fact.

## Recommendation

Adopt the nightly draft workflow for stable releases before more updater work.
Enable GitHub release immutability after CI signs and checks every target. Do not
use mutable `latest*.yml` as the operational control plane.

Add a signed, telemetry-free policy document and a client verifier. Use it for
stable and nightly rollout percentages, pause, bad-version blocking, and final
install authorization. Keep GitHub as the immutable artifact store.

## Uncertainties

- The reviewed repository files do not prove the signature state of existing
  release artifacts. Inspect representative artifacts on each platform before
  the implementation specification claims current signing coverage.
- GitHub documents draft publication as the recommended boundary, but it does
  not promise atomic asset visibility or cache invalidation. The design must
  tolerate a short propagation delay.
- The pinned Linux updater lacks a verified platform-signature guarantee
  comparable to macOS or Windows. Platform research must select the AppImage
  and DEB signature policy before implementation.
