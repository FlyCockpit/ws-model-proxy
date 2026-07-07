# Homebrew tap

This folder documents how to set up the Homebrew tap that distributes your tool.
**The tap is a separate GitHub repository**, not this folder — this folder just
holds the instructions (and is excluded from the published crate). Once set up,
your users install with:

```sh
brew install FlyCockpit/tap/wsmp
```

On every release, `dist` **generates** the formula (`wsmp.rb`) and attaches it
to the GitHub Release as an artifact. By default it is **not** pushed to the tap
for you — you copy it in (a few seconds, no extra secrets). See
"[Automating publish](#automating-publish-optional)" to make that automatic.

## One-time setup

**Create the tap repo.** Homebrew requires the name to start with `homebrew-`.
Create an empty public repo:

```
https://github.com/FlyCockpit/homebrew-tap
```

This must match the `tap = "FlyCockpit/homebrew-tap"` line in
`dist-workspace.toml`. That's the only setup the manual flow needs — no tokens.

**Install and authenticate GitHub CLI.** The manual publish flow uses `gh` to
download the formula from the release:

```sh
gh auth login
```

## Publishing a release (manual, default)

1. Cut a release as in `docs/releasing.md`. When it's green, the GitHub Release
   has a `wsmp.rb` formula among its artifacts.
2. Copy that formula into the tap repo and push it:

   ```sh
   gh release download vX.Y.Z --repo FlyCockpit/ws-model-proxy --pattern 'wsmp.rb' --dir /tmp
   # in a clone of FlyCockpit/homebrew-tap:
   mkdir -p Formula && cp /tmp/wsmp.rb Formula/wsmp.rb
   git add Formula/wsmp.rb && git commit -m "wsmp vX.Y.Z" && git push
   ```

   The formula already points at the new release's artifact URLs and checksums —
   you're just placing the generated file, not editing it.

That's it; `brew install FlyCockpit/tap/wsmp` now resolves the new version.

## Automating publish (optional)

To have CI push the formula on every release instead of doing it by hand:

1. **Create a token so CI can push to the tap.** The default `GITHUB_TOKEN`
   can't write to a *different* repo, so CI needs its own:

   - Create a fine-grained Personal Access Token (or classic with `repo` scope)
     that can write to `FlyCockpit/homebrew-tap`.
   - In **this** repo's settings → Secrets and variables → Actions, add it as
     `HOMEBREW_TAP_TOKEN`.

2. **Enable the publish job.** In `dist-workspace.toml`, add `"homebrew"` to
   `publish-jobs`:

   ```toml
   publish-jobs = ["homebrew"]
   ```

   Then regenerate the workflow with `cargo-dist` (never hand-edit
   `release.yml`):

   ```sh
   cargo install cargo-dist # if `dist` is not already installed
   dist generate
   ```

Now each release runs a `publish-homebrew-formula` job that commits
`Formula/wsmp.rb` into the tap repo for you. (Those commits are authored by the
CI token's identity — another reason some projects prefer the manual flow, where
the commit is plainly yours.)

## How users install

```sh
brew install FlyCockpit/tap/wsmp      # first time (adds the tap automatically)
brew upgrade wsmp                # later
```

## Notes

- The tap repo only ever contains generated formula files — you don't edit them
  by hand.
- If you rename the tap, update `dist-workspace.toml` and run `dist generate`
  with `cargo-dist`.
- Private repos don't work with `brew install` without auth — keep both this
  repo and the tap public for the smooth one-liner experience.
