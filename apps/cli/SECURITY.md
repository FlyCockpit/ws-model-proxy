# Security policy

## Reporting a vulnerability

Please report security issues privately via GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
(Security → Advisories → Report a vulnerability) rather than opening a public
issue. We'll acknowledge and work with you on a fix and disclosure timeline.

## What ships by default

This CLI includes several baseline protections:

- **`#![forbid(unsafe_code)]`-equivalent** lint at the crate level — no `unsafe`
  without an explicit, reviewed change.
- **`cargo-deny`** in CI: a license allowlist, banned/duplicate-crate checks,
  source allowlist (crates.io only), and **RUSTSEC advisory** scanning (this
  subsumes `cargo-audit`).
- **Gitleaks** in CI to catch common committed secrets beyond the lightweight
  repo-specific policy greps.
- **Dependabot** for Cargo crates and GitHub Actions, so dependencies and CI
  actions stay current; every update is gated by CI.
- **Policy checks** (`scripts/policy-checks.sh`) that grep for committed private
  keys, AWS keys, hook-bypass flags, and unsafe-lint overrides.
- **SHA-pinned GitHub Actions** in the hand-maintained CI workflow, with comments
  showing the upstream version tag. Dependabot updates the pinned SHAs.
- **Warnings-as-errors** (`-D warnings`) and `clippy` lints that forbid
  `unwrap()`/`panic!`/`dbg!`/`todo!` in production code.

## Hardening you may want to add

- **Enable GitHub code scanning / CodeQL** if your account has it.
- **Sign releases.** `dist` can be configured to attest/sign artifacts.

## Supported versions

Only the latest release is supported.
