# Releasing

Releases are automated by the root `Release` GitHub Actions workflow and
[`dist`](https://opensource.axo.dev/cargo-dist/) (cargo-dist). You bump the CLI
version, merge it to `master`, then manually run the workflow with that version
tag. CI builds every platform, generates installers and checksums, publishes a
GitHub Release, publishes the app container to GHCR, and commits the generated
Homebrew formula to `FlyCockpit/homebrew-tap`.

## What gets built

From `dist-workspace.toml`:

| Platform | Target triple |
|----------|---------------|
| Linux x86_64 | `x86_64-unknown-linux-gnu` |
| Linux ARM64 | `aarch64-unknown-linux-gnu` |
| macOS Intel | `x86_64-apple-darwin` |
| macOS Apple Silicon | `aarch64-apple-darwin` |
| Windows x64 | `x86_64-pc-windows-msvc` |

Installers generated: **shell** (`curl ... | sh`), **PowerShell** (`irm ... |
iex`), and a **Homebrew formula** (`wsmp.rb`). The formula is uploaded to the
GitHub Release and then copied into the tap as `Formula/wsmp.rb`.

Every archive is listed in `sha256.sum`, and the publish job signs build
provenance for the archives and `sha256.sum` with `actions/attest` (verify with
`gh attestation verify <file> --repo FlyCockpit/ws-model-proxy`). The server's
`/install.sh` downloads `wsmp-<target>.tar.xz` and `sha256.sum` from the release
of the server's version and refuses to install on a mismatch, so the publish job
fails before creating the release if a Linux or macOS archive or its checksum
entry is missing. Keep the archive names and the `.tar.xz` format (dist's
default) in step with `CLI_RELEASE_TARGETS` in `apps/server/src/node-http.ts`;
the server tests check both. The Linux builds run on Ubuntu 22.04 runners, so
they need glibc 2.34 or newer (`CLI_RELEASE_MIN_GLIBC`).

Self-update (`wsmp update`, the Nodes page's **Update**) downloads the same
archives, so the archive names and layouts (`wsmp-<target>/wsmp` in the
`.tar.xz`, `wsmp.exe` in the Windows `.zip`) are part of that contract too.
Release builds should set `WSMP_BUILD_COMMIT` to the commit they build (40
lowercase hex, for example `WSMP_BUILD_COMMIT: ${{ github.sha }}` in the build
job's environment): the binary reports it in its hello (`node.build.commit`), so
the server can tell two builds of one version apart. A build without it reports
the commit from its install receipt, or none.

### Keeping old nodes updatable

Self-update only works while a node can still connect and take the next update, so:

- **Never turn away a wsmp that reports `features.selfUpdate` at hello.** The server refuses
  wsmp builds older than self-update by capability (a hello without `features.selfUpdate` gets
  `upgrade_cli`), not by bumping the relay protocol. Protocol 3.0 is permanent (`AGENTS.md`,
  "Versions and Releases"): a new capability is new frames or optional fields, used only with
  nodes that report it.
- **Fields added later to what a node sends stay optional**, in the hello and every other
  frame: a released wsmp never sends them.
- **A server may add optional fields to any frame.** wsmp (from 0.4.3) ignores fields it does
  not know in every frame and binary metadata the server sends, at any depth, except runtime
  definitions (`runtime.define`'s `put` entries and `node` part): a wsmp refuses a definition it
  cannot fully read on its own (`invalid`, with the path) and applies the rest.
- **Never remove, rename or retype a field** the server sends: an older wsmp cannot read the
  frame.
- **Never add a value to an existing enum field** (`hello.ok`'s `definitionSync`, say): an
  older wsmp cannot read the frame. Add a new field instead. The exceptions, which wsmp reads
  as a generic value: `protocol.error`'s `code` (a generic error, then it reconnects), a
  failure `reason` (`relay.cancel`, `stt.close`: read as `unknown`), and a job's
  `operator.commandAuthor` (read as `unknown`).
- **Never add a field that limits what a node may do**: an older wsmp ignores it and does the
  thing anyway. Such a limit needs a new frame, or the server checks a feature the node reports
  at hello first (as with `features.selfUpdate`). The same rules hold for the answers `wsmp
  login` reads (`/.well-known/wsmp` and enrollment), which wsmp also reads leniently.
- **CI holds the server to these rules.** `apps/cli/tests/fixtures/released/<version>/` keeps
  every frame and binary metadata a released wsmp sends and reads, and the fixed values (enum
  and literal fields) the server sent then. `apps/server/src/relay/released-compat.test.ts`
  checks that today's server accepts the first, still sends every field the release reads with
  the same type, and sends no fixed value the release cannot read. When you cut a release, run
  `pnpm --filter server freeze-relay-release <version>`. Never edit a
  released copy to make the test pass; change the server instead. The `0.4.3` copy may still
  follow protocol changes until `v0.4.3` is tagged: delete it and run the script again.
- The browser update is offered only where it has been verified on a real machine
  (`AGENT_UPDATE_OFFERED` in `packages/api/src/lib/agent-updates.ts`): add a platform there,
  with a server deploy, once its dead-man, restart and confirmation pass on it. Windows is
  verified but opt-in (`WMP_AGENT_UPDATE_WINDOWS`) until its binaries are signed (#254).

Homebrew orders versions its own way: `0.4.3-rc.1`, `-alpha` and `-beta` sort before `0.4.3`,
but other suffixes (`0.4.3-test.1`) sort after it, so `brew upgrade` would never move from such a
build to the release. Name pre-release and test builds `-rc.N`, `-alpha.N` or `-beta.N`.

The Homebrew formula is generated by dist and cannot write the install receipt
(`<state>/install.json`) itself; wsmp recognises a Homebrew install from its
`Cellar` path and writes the receipt after its first update.

The container image is published to GHCR as:

```text
ghcr.io/flycockpit/ws-model-proxy:vX.Y.Z
ghcr.io/flycockpit/ws-model-proxy:X.Y.Z
ghcr.io/flycockpit/ws-model-proxy:sha-<commit-sha>
ghcr.io/flycockpit/ws-model-proxy:latest   # only when publish_latest is true
```

## Cutting a release

```sh
# 1. Bump apps/cli/Cargo.toml (e.g. 0.1.0 -> 0.1.1) and SERVER_VERSION in
#    apps/server/src/version.ts to match (a server test checks they agree).
# 2. Flip the CLI install default to release binaries (same commit; see below).
#    Write the upgrade notes as docs/release-notes/X.Y.Z.md (same commit). The
#    workflow refuses to release without that file and puts it at the top of
#    the GitHub Release body, above cargo-dist's install section. Fold in
#    docs/release-notes/unreleased.md (notes collected since the last release)
#    and delete it.
# 3. Merge that change to master.
git push origin master
# 4. In GitHub Actions, run the root "Release" workflow from master with:
#    version = v0.1.1
```

### Flip the CLI install default to release binaries

Until a version is released, `/install.sh` on an unconfigured server builds the preview branch
(`CLI_PREVIEW_BRANCH`) from source, because the release it would download does not exist yet;
release binaries are opt-in through `WMP_CLI_RELEASE_BASE_URL`. In the release commit, set
`CLI_RELEASE_BINARIES_BY_DEFAULT = true` in `apps/server/src/node-http.ts` (it is marked
`RELEASE FLIP`). From then on an unconfigured server installs the checksum-verified binaries
from the GitHub Release of `SERVER_VERSION`, and only machines without a matching binary build
the version's tag from source. A server that deploys the flip commit before the Release workflow
has published the GitHub Release cannot install nodes until it has (the script stops at the
missing `sha256.sum`), so run the workflow right after merging, or deploy from the published
image. After the release, set the constant back to `false` (and point `CLI_PREVIEW_BRANCH` at the
next preview branch) when work on the next version starts.

The workflow validates that it is running from `master` and that the requested
`vX.Y.Z` tag matches `apps/cli/Cargo.toml`. It creates the GitHub Release for
that tag, uploads CLI artifacts, publishes the app container to GHCR, and pushes
the generated Homebrew formula to the tap.

## Relay protocol changes

The server accepts the relay protocol versions listed in
`RELAY_PROTOCOL_VERSIONS` (apps/server/src/relay/protocol.ts), oldest first. A
protocol bump ships the server and wsmp together when the oldest accepted
version moves.

A release bumps the protocol at most once. The 0.4.x releases speak relay protocol
3.0 (v0.3.x spoke 2.4) and support only that version. Compatible optional
extensions do not require a protocol bump: 0.4.1's encrypted terminal image
uploads retain 3.0 and start only after the CLI advertises support. A 0.4.0 CLI
remains usable with the 0.4.1 server, but must be upgraded to use image paste.

When a release moves the oldest accepted protocol version, its release notes
must require upgrading the server and every CLI together. Older CLIs are
refused with an upgrade-CLI message; this CLI against an older server reports
that the server needs upgrading. A genuine future-server upgrade-CLI reply
still identifies the CLI as the component needing an upgrade. Historical
wire fixtures retain their original directory names; that is not a claim
that the current release supports those older negotiated versions.

## One-time setup

1. **Repos must be public** for `curl | sh`, `brew install`, and unauthenticated
   container pulls to work without GitHub tokens.
2. **Homebrew tap:** keep `FlyCockpit/homebrew-tap` public. See
   `tap/README.md`.
3. **Release environment and tap token:** create a protected `release`
   environment in `FlyCockpit/ws-model-proxy`, then add `HOMEBREW_TAP_TOKEN`
   as an environment secret. Use a fine-grained token with `contents:write`
   access to `FlyCockpit/homebrew-tap`. The default `GITHUB_TOKEN` cannot push
   to another repository.
4. **GHCR package visibility:** after the first release, make the GHCR package
   public if you want unauthenticated users to pull it.
5. **Optional local cargo-dist:** CI installs `cargo-dist` for releases, so
   normal release cutting does not require it locally. Install it only when you
   want to validate or regenerate release config from your machine:

   ```sh
   cargo install cargo-dist
   dist plan
   ```

## Installation after release

```sh
brew install flycockpit/tap/wsmp

curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/FlyCockpit/ws-model-proxy/releases/latest/download/wsmp-installer.sh | sh

docker pull ghcr.io/flycockpit/ws-model-proxy:latest
```

## Changing release behavior

The root `.github/workflows/release.yml` owns monorepo release orchestration.
Cargo-dist artifact behavior still comes from `dist-workspace.toml`. When you
change artifact targets or installers, edit `dist-workspace.toml`, install
`cargo-dist` if needed, then inspect the generated output before porting the
relevant changes into the root workflow:

```sh
cargo install cargo-dist # if `dist` is not already installed
dist init      # interactive; or
dist generate  # re-emit release.yml from the config
```

CI has no release drift check, so review cargo-dist workflow changes
deliberately whenever you change `dist-workspace.toml`.

## Optional: crates.io and cargo-binstall

Not enabled by default. To also publish to crates.io so `cargo install` /
`cargo binstall` work:

1. Add a `CARGO_REGISTRY_TOKEN` secret.
2. Add `"cargo:"` to a publish step (see dist docs on `publish-jobs`), or run
   `cargo publish` in a small added job. `dist`'s artifacts already carry the
   metadata `cargo binstall` needs.
