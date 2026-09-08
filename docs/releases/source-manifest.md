# Source release manifest

Starting with IronCrew 0.4.2, `release-manifest.json` uses **schemaVersion 3**.
This document describes the source archive contract. It is separate from the
signed native updater manifest and does not make a source archive installable
through the native updater.

## Schema history and transition

| Release       | Schema | Shape                                                                                                                   |
| ------------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| 0.4.0         | 2      | `source.file`, `source.size`, `requirements`, `verification.status`, `verification.runs`, `container`, `nativePackages` |
| 0.4.1         | 1      | `archive.name`, `archive.bytes`, `verification` array, `distribution`; requirements were omitted                        |
| 0.4.2 onwards | 3      | Retains the 0.4.1 archive/evidence shape and restores exact `requirements.node` and `requirements.pnpm`                 |

The schema number regression in 0.4.1 was a release defect. Schema 3 identifies
an explicit contract change; it does not claim compatibility with schema 2.
Existing historical assets are unchanged. Consumers must dispatch on the exact
numeric `schemaVersion` before reading fields. A schema 3 consumer must reject
missing, string-valued, and unsupported versions (including 1 and 2), rather than
falling back to field names or inferring compatibility from the application version.
A consumer that also supports historical releases needs separate schema handlers.

## Schema 3 fields

All fields below are required. Hashes are lowercase SHA-256 hex strings.

| Field                                  | Type and meaning                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `schemaVersion`                        | Number, exactly `3`                                                                                                |
| `kind`                                 | String, exactly `source-release`                                                                                   |
| `repository`                           | GitHub `owner/repository`                                                                                          |
| `version`                              | Stable application version from committed `next/package.json`                                                      |
| `tag`                                  | `v` followed by `version`                                                                                          |
| `commit`                               | Full 40-character Git commit SHA archived and verified by CI                                                       |
| `applicationDirectory`                 | String, exactly `next`                                                                                             |
| `requirements.node`                    | Exact stable `major.minor.patch` from committed `next/package.json` → `engines.node`                               |
| `requirements.pnpm`                    | Exact stable `major.minor.patch` from committed `next/package.json` → `packageManager`, without the `pnpm@` prefix |
| `archive.name`                         | `ironcrew-<version>-source.tar.gz`                                                                                 |
| `archive.sha256`                       | Hash of the archive bytes                                                                                          |
| `archive.bytes`                        | Positive integer archive byte length                                                                               |
| `notes.path`                           | `docs/releases/v<version>.md` within the repository                                                                |
| `notes.sha256`                         | Hash of the committed release notes bytes                                                                          |
| `verification`                         | Array of successful CI workflow evidence for `commit`                                                              |
| `verification[].workflow`              | Workflow filename                                                                                                  |
| `verification[].runId`                 | Numeric GitHub Actions run ID                                                                                      |
| `verification[].attempt`               | Numeric run attempt                                                                                                |
| `verification[].url`                   | GitHub Actions run URL                                                                                             |
| `verification[].jobs`                  | Array of successful job names                                                                                      |
| `distribution.ociImage`                | Boolean `false`                                                                                                    |
| `distribution.signedNativePackage`     | Boolean `false`                                                                                                    |
| `distribution.nativeUpdaterCompatible` | Boolean `false`                                                                                                    |

For 0.4.2, the requirements are Node `26.4.0` and pnpm `10.30.1`. The publisher
reads these values from the release commit, not its working tree or runner.
Missing versions, version ranges, prereleases, or another package manager stop
packaging before assets are created. Future exact toolchain pins are reflected
in the manifest without requiring a schema change.

## Consumer verification

1. Select the supported schema explicitly, then validate its required fields.
2. Compare `tag`, `version`, and `commit` with the intended GitHub release/tag.
3. Verify the archive and manifest against `SHA256SUMS`, then verify archive byte
   length and hash against `archive`. Checksums detect corruption; these source
   assets are not a signed native package.
4. Inspect the archive's Git commit identifier and committed
   `next/package.json`; confirm the version and exact toolchain requirements.
5. Verify the archived release notes against `notes.sha256` and check the
   referenced CI runs belong to the intended commit and succeeded.

The archive contains the full committed repository under `ironcrew-<version>/`.
`SHA256SUMS` contains the SHA-256 digests for the archive and manifest. The existing
publisher still requires all five release workflows for the exact main commit,
checks every required platform job, checks existing tag/asset identity, and
rechecks the gates before publishing.

The independent consumer contract in
[`source-release.test.mjs`](../../scripts/release/source-release.test.mjs)
reads the serialized manifest asset, checks the packaged source and toolchain
binding, verifies hashes, and rejects unsupported schema versions.
