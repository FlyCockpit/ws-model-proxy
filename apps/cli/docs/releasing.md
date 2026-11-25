# Releasing

Releases are automated by the root `Release` GitHub Actions workflow and
[`dist`](https://opensource.axo.dev/cargo-dist/) (cargo-dist). You bump the CLI
version, merge it to `main`, then manually run the workflow with that version
tag. CI builds every platform, generates installers and checksums, publishes a
GitHub Release, publishes the app container to GHCR, and commits the generated
Homebrew formula to `FlyCockpit/homebrew-tap`.

## What gets built

From `dist-workspace.toml`:

| Platform | Target triple |
|----------|---------------|
| Linux x86_64 (glibc ≥ 2.34; the default) | `x86_64-unknown-linux-gnu` |
| Linux ARM64 (glibc ≥ 2.34; the default) | `aarch64-unknown-linux-gnu` |
| Linux x86_64 (static: Alpine, older glibc) | `x86_64-unknown-linux-musl` |
| Linux ARM64 (static: Alpine, older glibc) | `aarch64-unknown-linux-musl` |
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
the server tests check both.

**Linux flavours: glibc by default, static musl where glibc cannot run.** `/install.sh`
installs the GNU build when the machine's glibc is at least `CLI_RELEASE_MIN_GLIBC`
(2.34, `apps/server/src/node-http.ts`), as 0.4.x did, and the static musl build only on musl
systems (Alpine), older glibc, or a libc it cannot identify. wsmp is the suite's documented
exception to "Linux release binaries prefer musl": a node often reaches its server or its
model servers by an mDNS `*.local` name, which only a glibc build resolves (through NSS);
a static musl build cannot. Both flavours ship in every release: GNU for normal Linux, released
0.4.x `wsmp update` (it requests its compiled `*-unknown-linux-gnu` manifest key and extracts
`wsmp-<its own GNU triple>/wsmp`) and Homebrew's Linux blocks (cargo-dist generates them from
GNU targets); musl for Alpine and old glibc. `wsmp update` and server-pushed updates keep each
node on its compiled target.

Release jobs reject musl binaries with an ELF interpreter or shared-library dependencies and
add `musl-COPYRIGHT.txt` to each musl archive, refreshing its checksum and manifest hash
before global artifacts are generated.

**The glibc floor is checked.** The GNU runners stay on `ubuntu-22.04` / `ubuntu-22.04-arm`
(glibc 2.35), and `scripts/check-glibc-floor.sh` fails the release (`release.yml`, "Verify the
GNU binaries' glibc floor") and CLI CI (`cli-ci.yml`, `glibc-floor`) when a GNU binary needs a
`GLIBC_x.y` symbol version above 2.34. The floor appears in those two workflows and in
`CLI_RELEASE_MIN_GLIBC`; a server test keeps them equal. These OS-dependent pins are
intentional; 22.04 retires on 2027-04-17, so plan the move (an older-glibc build container,
with the same check) before March 2027. Musl x86_64 builds and
global release jobs use `ubuntu-latest`. Musl ARM64 uses `ubuntu-24.04-arm`: GitHub has
no `ubuntu-latest` arm64 label; this is the matching arm image as of 2026-11. Apple
Silicon stays on `macos-15`. Container builds use `ubuntu-latest` / `ubuntu-24.04-arm`.

Self-update (`wsmp update`, the Nodes page's **Update**) downloads the same
archives, so the archive names and layouts (`wsmp-<target>/wsmp` in the
`.tar.xz`, `wsmp.exe` in the Windows `.zip`) are part of that contract too.
Release builds should set `WSMP_BUILD_COMMIT` to the commit they build (40
lowercase hex, for example `WSMP_BUILD_COMMIT: ${{ github.sha }}` in the build
job's environment): the binary reports it in its hello (`node.build.commit`), so
the server can tell two builds of one version apart. A build without it reports
the commit from its install receipt, or none.

### Updating nodes within a release line

Server and wsmp 1.0 speak only relay 4.0 (`ws-model-proxy.relay.v4`). An update
pushed from the Nodes page travels over the relay, so it reaches only nodes that can
connect: a 1.0 server refuses a 0.4.x websocket upgrade before it can send one.
`wsmp update` run on the node is different: it reads the server's
`/cli/manifest.json` over plain HTTPS, so a 0.4.x node can still use it to move to 1.0
(script installs; Homebrew nodes use `brew upgrade wsmp`). Keep the manifest's shape
stable for that reason. See [UPGRADING.md](../../../UPGRADING.md).

Within a release line, advertise optional capabilities through hello `features`
and send capability-dependent work only to nodes that report support. Version
numbers are changed only by the owner in the release commit.

Preserve the upgrade-signalling shapes permanently: the HTTP 426 body keys and
types (`type`, `failure`, `code`, `message`, `supportedVersions`,
`supportedSubprotocol`), with `code: "upgrade_cli"`, and all five
`/.well-known/wsmp` fields (`serverVersion`, `protocolVersion`, `origin`,
`installScript: "/install.sh"`, `enrollPath: "/api/node/enroll"`). Released CLIs
parse them to print upgrade instructions. See [the handshake guide](relay-protocol.md).

The browser update is offered only where it has been verified on a real machine
(`AGENT_UPDATE_OFFERED` in `packages/api/src/lib/agent-updates.ts`). Add a platform
there after its rollback, restart and confirmation pass on it. Windows remains
opt-in through `WMP_AGENT_UPDATE_WINDOWS` until its binaries are signed (#254).

Homebrew orders versions its own way: `1.0.1-rc.1`, `-alpha` and `-beta` sort before `1.0.1`,
but other suffixes (`1.0.1-test.1`) sort after it, so `brew upgrade` would never move from such a
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

## Manual Windows checks before a release

CI builds and unit-tests the Windows target, but nothing in CI runs Task Scheduler. Before
1.0.0 (and any release that touches `src/host/service.rs`, `src/host/service/task_scheduler.rs`,
`src/host/service/task_names.rs`, `src/host/service/windows_task.rs`, `src/app/commands/setup/service.rs` or the
update dead-man), check these by hand on a real Windows 10/11 machine, as a standard user,
and note the results in the release PR. Inspect tasks with `schtasks /Query /FO LIST /V` and
`Get-ScheduledTask | ? TaskName -like 'wsmp-*' | ft TaskName,State,@{n='User';e={$_.Principal.UserId}}`.

- [ ] **Fresh install.** No `wsmp-*` task exists. `irm https://<server>/install.ps1 | iex`, then
      `wsmp service install`: exactly one task `wsmp-relay-<SID>` (the SID from `whoami /user`),
      running, principal = you; no `wsmp-relay-<username>` task. The node is online. Log off and
      on: it starts again. `wsmp service status`, `restart` and `logs` work.
- [ ] **Upgrade from 0.4.3 with `wsmp service install`.** Install 0.4.3 and its service
      (`wsmp-relay-<username>` exists). Install the 1.0 binary, run `wsmp service install`:
      it prints "replaced the wsmp 0.4 scheduled task"; afterwards only `wsmp-relay-<SID>`
      exists and runs, the node reconnects, and running install again changes nothing else.
- [ ] **Upgrade from 0.4.3 with `wsmp update`** (0.4.3's updater) and then the web app's
      update: the node runs 1.0 from `wsmp-relay-<username>`; `wsmp service status` and
      `wsmp service restart` (1.0) act on it; the 0.4.3 dead-man `wsmp-update-deadman-<username>`
      is removed when 1.0 confirms, and no second dead-man is left behind. A later `wsmp update`
      (1.0 → 1.0.x test build) moves the relay onto `wsmp-relay-<SID>` and deletes the old task.
- [ ] **Rollback during the 0.4.3 → 1.0 trial.** Make 1.0 fail to connect (for example a wrong
      server URL) so it rolls back: 0.4.3 runs again from `wsmp-relay-<username>` and
      `wsmp service status` (0.4.3) still works; no SID-named task was created.
- [ ] **Two accounts with the same user name** (a local `jo` and a domain `DOMAIN\jo`, or two
      domains; one of them an administrator). As account A install 0.4.3's service. As account B
      install 1.0 and run `wsmp service install`: B gets `wsmp-relay-<B's SID>`, A's
      `wsmp-relay-jo` is untouched (same principal, still runs at A's logon), and B's install
      prints "left the scheduled task `wsmp-relay-jo` alone". Then as A install 1.0: A's old task
      is replaced by `wsmp-relay-<A's SID>`. Both relays run at the same time on their own tasks.
      `wsmp service uninstall` as B removes only B's task.
- [ ] **Uninstall.** After each upgrade path above, `wsmp service uninstall` removes
      `wsmp-relay-<SID>` and your own `wsmp-relay-<username>` (if any) and the definition file;
      running it twice succeeds; no `wsmp-*` task of yours remains.
- [ ] **Install during the 0.4.3 → 1.0 trial.** Right after 0.4.3's `wsmp update` installs
      1.0 (before `wsmp update status` shows it confirmed), run `wsmp service install` (1.0):
      it notes it kept `wsmp-relay-<username>`; no SID task appears. Force a rollback: 0.4.3
      restarts from that task. After a confirmed trial, install moves the task.
- [ ] **Downgrade refused.** With the service installed (either task name), `wsmp update`
      against a server that offers 0.4.x refuses, names `wsmp service uninstall`, and arms no
      dead-man.
- [ ] **A broken unrelated task.** With another task on the machine that `schtasks /Query`
      cannot read (a corrupt task file under `\Microsoft\…`), `wsmp service status`, `restart`,
      `install`, `uninstall` and `wsmp update` still work (they ask for their own task by name).
- [ ] **Rollback after a move.** `wsmp update` from 1.0 to a 1.0.x test build that cannot
      connect: the task moved to `wsmp-relay-<SID>` before the restart; the dead-man rolls back
      to 1.0, which restarts `wsmp-relay-<SID>`. Note whether the dead-man's 5-second kick and
      the move overlapped (an extra start in `wsmp update status` is harmless).
- [ ] **Scheduler unavailable.** Stop the Task Scheduler service (as administrator) or run
      under a policy that blocks `schtasks`: `wsmp service uninstall` fails and keeps
      `wsmp-relay-task.xml`; it never reports success with a task left behind.
- [ ] **PowerShell blocked.** With PowerShell disabled by policy, `Export-ScheduledTask` fails:
      install leaves `wsmp-relay-<username>` with a note naming `schtasks /Delete`, uninstall
      reports it the same way, and no 0.4 task is deleted.
- [ ] **Failed delete.** Deny your account delete rights on `wsmp-relay-<username>` (or hold it
      open), then install: the SID task runs, the command exits non-zero naming the old task,
      and the next `wsmp service install` deletes it.
- [ ] **Non-ASCII account.** A user name and profile path with non-ASCII letters (for example
      `Jösé`): ownership is recognized (the export is read as UTF-8) and the old task is replaced.
- [ ] **Dead-man tasks.** After each path above, `Get-ScheduledTask wsmp-update-deadman-*` lists
      no task of yours once the update is confirmed or rolled back.
- [ ] **Export format.** On one machine, compare `Export-ScheduledTask -TaskName wsmp-relay-<username>`
      for a 0.4.3 task with what `task_names::task_owner` expects: the `<Principals>`
      `<UserId>` is the SID (or `DOMAIN\user`) and `<Arguments>` carries `--state-dir`. If the
      principal reads back differently, ownership is "unknown" and install leaves the old task
      with a note, which must then be fixed before release.

## Cutting a release

```sh
# 1. Bump apps/cli/Cargo.toml (e.g. 1.0.0 -> 1.0.1) and SERVER_VERSION in
#    apps/server/src/version.ts to match (a server test checks they agree).
# 2. Flip the CLI install default to release binaries (same commit; see below).
#    Write the upgrade notes as docs/release-notes/X.Y.Z.md (same commit). The
#    workflow refuses to release without that file and puts it at the top of
#    the GitHub Release body, above cargo-dist's install section. Fold in
#    the notes collected since the last release into that versioned file.
# 3. Merge that change to main.
git push origin main
# 4. In GitHub Actions, run the root "Release" workflow from main with:
#    version = v1.0.1
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

The workflow validates that it is running from `main` and that the requested
`vX.Y.Z` tag matches `apps/cli/Cargo.toml`. It creates the GitHub Release for
that tag, uploads CLI artifacts, publishes the app container to GHCR, and pushes
the generated Homebrew formula to the tap.

## Relay protocol changes

Each release line uses one protocol: 1.0 speaks only relay 4.0 and WebSocket
subprotocol `ws-model-proxy.relay.v4`. The owner changes the protocol when a new
release line needs an incompatible wire format, shipping server and wsmp together.
Optional capability extensions still use hello `features` without a protocol bump.

When the protocol changes, release notes must require upgrading the server and
every CLI together. A server refuses other subprotocols with HTTP 426 and
`code: "upgrade_cli"`; the refusal and discovery response shapes above must never
change. A 1.0 CLI against a 0.4.x server reports "upgrade the server". The current
cross-language fixtures live in `apps/cli/tests/fixtures/relay-4.0`; they define
the current protocol, without a separate released-version freeze or compatibility gate.

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
