<!-- GENERATED FILE — DO NOT EDIT.
     Edit AGENTS.md, then run `cargo xtask sync-docs`. -->

# CLI Agent & Contributor Guide

This file covers the Rust CLI under `apps/cli`. The repo-root `AGENTS.md` still applies; use this file for CLI-specific conventions.

`CLAUDE.md` and `.cursorrules` are generated mirrors of this file.
Edit `AGENTS.md`, then run `cargo xtask sync-docs`. CI fails if the mirrors drift.

## What This Is

The Rust command-line relay client for WS Model Proxy. The `wsmp` CLI authenticates with the web app, manages local endpoint configuration, probes OpenAI-compatible endpoints, and keeps the outbound websocket relay connected.

## Orientation

| Path | What's there |
| ---- | ------------ |
| `src/lib.rs` | Shared implementation modules used by the binary and tests. |
| `src/main.rs` | Entry point: parse arguments, initialize logging, dispatch, map errors to exit codes. |
| `src/cli.rs` | Clap argument definitions. Keep CLI shape here and command logic elsewhere. |
| `src/commands/` | One file per subcommand, each exposing `Args` and `run(&Args)`. |
| `src/config.rs` | Local TOML config structs, load/save, endpoint inventory. |
| `src/state.rs` | Stored device credentials and mutable local relay state. |
| `src/daemon.rs` | Foreground websocket relay session. |
| `src/probe.rs` | Endpoint/model capability probing. |
| `src/paths.rs` | Cross-platform config/data directories via `dirs`. |
| `src/logging.rs` | Tracing setup. Logs go to stderr. |
| `src/exit.rs` | Stable process exit codes. |
| `tests/cli.rs` | Black-box tests that run the built binary. |
| `xtask/` | CLI workspace automation: `sync-docs`. |
| `docs/` | CLI-specific error handling and release notes. |
| `tap/` | Notes for publishing the generated Homebrew formula. |

## Everyday Commands

```sh
cargo build
cargo test
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo fmt
cargo run -- config path
cargo xtask sync-docs
```

Before considering a CLI change done, run:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets --locked
cargo test --workspace --doc --locked
cargo xtask sync-docs --check
```

`cargo deny check` and `typos` also run in CI.

## Hard Rules

1. Do not weaken lint or CI gates to make a change pass. Fix the issue instead.
2. Do not bypass commit or CI checks with `git commit --no-verify` or force-pushing the default branch.
3. No `unsafe`; the crate forbids it.
4. No secrets in source, tests, fixtures, docs, or commit messages.
5. Do not add dependencies casually. Prefer the standard library and explain new crates.
6. stdout is for command output only. Logs, progress, and diagnostics go to stderr.
7. No `unwrap()`, `panic!`, `todo!`, or `dbg!` in non-test code.
8. Do not run destructive shell commands or `sudo` on the user's behalf.
9. Do not create backup copies such as `.bak`, `.old`, or copied source files.

## Conventions

- Application code returns `anyhow::Result<T>`. Add context at file, network, parse, and protocol boundaries.
- Quote identifiers and paths in backticks. Keep error messages lowercase and omit trailing periods.
- Exit codes are public behavior; see `src/exit.rs` before adding or changing one.
- Any command that prints structured data should support `--json` and emit from a typed `Serialize` struct.
- Use `src/output.rs` for stdout writes so output behavior stays deliberate.
- Pure logic tests can live next to code under `#[cfg(test)]`; CLI behavior tests belong in `tests/`.

## Adding a Command

1. Add `src/commands/<name>.rs` with an `Args` type and `run(&Args) -> anyhow::Result<()>`.
2. Register the module in `src/commands/mod.rs`.
3. Add a variant to `Command` in `src/cli.rs`.
4. Add a match arm in `src/main.rs`.
5. Add focused black-box tests in `tests/cli.rs` when the command affects user-visible behavior.

## Releasing

Releases are handled by the root `Release` GitHub Actions workflow and `dist` (cargo-dist).

1. Bump `version` in `Cargo.toml`.
2. Merge that change to `master`.
3. Manually run the root `Release` workflow from `master` with the matching tag, for example `v0.1.1`.
4. The workflow builds all platforms, generates installers and checksums, publishes a GitHub Release, and publishes the app container to GHCR.

Cargo-dist artifact behavior lives in `dist-workspace.toml`; root release workflow owns monorepo orchestration. See `docs/releasing.md`.
