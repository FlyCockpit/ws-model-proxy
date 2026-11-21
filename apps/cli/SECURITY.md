# Security policy

## Reporting a vulnerability

Please report security vulnerabilities **privately** through
[GitHub private vulnerability reporting](https://github.com/FlyCockpit/ws-model-proxy/security/advisories/new).
Do not open public issues, discussions or pull requests for security problems.
We aim to acknowledge reports within 72 hours and agree on a fix and disclosure timeline.

## What ships by default

This CLI includes several baseline protections:

- **`#![forbid(unsafe_code)]`-equivalent** lint at the crate level — no `unsafe`
  without an explicit, reviewed change.
- **`cargo-deny`** in CI: a license allowlist, banned/duplicate-crate checks,
  source allowlist (crates.io only), and **RUSTSEC advisory** scanning (this
  subsumes `cargo-audit`).
- **TruffleHog** in CI to catch common committed secrets beyond the lightweight
  repo-specific policy greps.
- **Dependabot** for Cargo crates and GitHub Actions, so dependencies and CI
  actions stay current; every update is gated by CI.
- **Policy checks** (`scripts/policy-checks.sh`) that grep for committed private
  keys, AWS keys, hook-bypass flags, and unsafe-lint overrides.
- **SHA-pinned GitHub Actions** in the hand-maintained CI workflow, with comments
  showing the upstream version tag. Dependabot updates the pinned SHAs.
- **Warnings-as-errors** (`-D warnings`) and `clippy` lints that forbid
  `unwrap()`/`panic!`/`dbg!`/`todo!` in production code.

## Supported versions

Only the 1.0.x release line is supported. Versions 0.4.x and earlier are unsupported.
