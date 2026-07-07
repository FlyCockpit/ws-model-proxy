# Releasing

Releases are automated by the root `Release` GitHub Actions workflow and
[`dist`](https://opensource.axo.dev/cargo-dist/) (cargo-dist). You bump the CLI
version, merge it to `master`, then manually run the workflow with that version
tag. CI builds every platform, generates installers + checksums, publishes a
GitHub Release, and publishes the app container to GHCR. Updating your Homebrew
tap is a manual copy step by default (and can be automated — see
`tap/README.md`).

## What gets built

From `dist-workspace.toml`:

| Platform | Target triple |
|----------|---------------|
| Linux x86_64 | `x86_64-unknown-linux-gnu` |
| Linux ARM64 | `aarch64-unknown-linux-gnu` |
| macOS Intel | `x86_64-apple-darwin` |
| macOS Apple Silicon | `aarch64-apple-darwin` |
| Windows x64 | `x86_64-pc-windows-msvc` |

Installers generated: **shell** (`curl … | sh`), **PowerShell** (`irm … | iex`),
and a **Homebrew formula** (`wsmp.rb`), attached to the release as an artifact.
You copy that formula into your tap repo to publish it — see `tap/README.md`.

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
that tag, uploads CLI artifacts, and publishes the app container to GHCR.

## One-time setup

1. **Repo must be public** for `curl | sh` and `brew install` to work without
   auth tokens.
2. **GitHub CLI:** install `gh` and run `gh auth login`; the default Homebrew
   publishing flow uses it to download the generated formula.
3. **Homebrew tap:** create the tap repo — see `tap/README.md`. No token is
   needed for the default manual publish flow; one is only required if you opt
   into automatic publishing.
4. **Optional local cargo-dist:** CI installs `cargo-dist` for releases, so
   normal release cutting does not require it locally. Install it only when you
   want to validate or regenerate release config from your machine:

   ```sh
   cargo install cargo-dist
   dist plan
   ```

### Publishing the Homebrew formula

By default the formula is generated as a release artifact and you copy it into
your tap repo yourself — a few seconds, no extra secrets, and the tap commit is
plainly yours. The steps (and how to automate it instead) are in
`tap/README.md`.

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

CI has no "release drift" check, so review cargo-dist workflow changes
deliberately whenever you change `dist-workspace.toml`.

## Optional: crates.io and cargo-binstall

Not enabled by default. To also publish to crates.io so `cargo install` /
`cargo binstall` work:

1. Add a `CARGO_REGISTRY_TOKEN` secret.
2. Add `"cargo:"` to a publish step (see dist docs on `publish-jobs`), or run
   `cargo publish` in a small added job. `dist`'s artifacts already carry the
   metadata `cargo binstall` needs.
