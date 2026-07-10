# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately**, not via public issues:

- Preferred: open a private advisory on the repository's
  [Security tab -> "Report a vulnerability"](../../security/advisories/new).
- If private advisories are unavailable, contact the repository owner privately.

We aim to acknowledge reports within 72 hours.

## Supported versions

Only the latest release is supported.

## Security controls

- pnpm 11 supply-chain hardening: release-age gate, exotic-subdependency
  blocking, build-script allowlist, and sha512-pinned package manager.
- SHA-pinned GitHub Actions kept current by Dependabot.
- Trufflehog verified-secret scanning on every PR.
- Trivy HIGH/CRITICAL image scanning on every container build.
- `pnpm audit` on every PR with `--audit-level=high`.
- Non-root `USER node` in the production server image.
- Tight Content-Security-Policy and `secureHeaders` middleware.
- Cookie-only Better Auth session resolution that discards bearer
  `Authorization`; model and CLI credentials remain scoped to their dedicated
  API and WebSocket surfaces.
- Tiered rate limiting for signup and auth routes.
- Production boot guards for weak or missing `BETTER_AUTH_SECRET`.

See `AGENTS.md` for the guardrails an AI coding agent must respect when
working in this repo.

## SSR and rendered content

The dashboard does not render user-authored or CMS Markdown/HTML. Its only
`dangerouslySetInnerHTML` usage is the repository-owned theme bootstrap string,
authorized by a matching CSP hash. TanStack Start hydration scripts receive a
per-request CSP nonce. If untrusted rich text is introduced later, it must be
sanitized before rendering and the CSP must not be weakened to accommodate it.


## Features that need a paid GitHub tier

The defaults above work on any repository, public or private, with no GitHub
Advanced Security subscription. These are intentionally not shipped because they
require GHAS on private repos:

- CodeQL for generic JS/TS SAST.
- GitHub Dependency Review Action.

If your repository is public, or you have GHAS, either can be added as a
workflow with no product behavior change.
