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

The container image is published to GHCR as:

```text
ghcr.io/flycockpit/ws-model-proxy:vX.Y.Z
ghcr.io/flycockpit/ws-model-proxy:X.Y.Z
ghcr.io/flycockpit/ws-model-proxy:sha-<commit-sha>
ghcr.io/flycockpit/ws-model-proxy:latest   # only when publish_latest is true
```

## Cutting a release

```sh
# 1. Bump apps/cli/Cargo.toml (e.g. 0.1.0 -> 0.1.1).
# 2. Merge that change to master.
git push origin master
# 3. In GitHub Actions, run the root "Release" workflow from master with:
#    version = v0.1.1
```

The workflow validates that it is running from `master` and that the requested
`vX.Y.Z` tag matches `apps/cli/Cargo.toml`. It creates the GitHub Release for
that tag, uploads CLI artifacts, publishes the app container to GHCR, and pushes
the generated Homebrew formula to the tap.

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
