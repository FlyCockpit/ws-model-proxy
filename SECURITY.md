# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately** through
[GitHub private vulnerability reporting](https://github.com/FlyCockpit/ws-model-proxy/security/advisories/new).
Do not open public issues, discussions or pull requests for security problems.
We aim to acknowledge reports within 72 hours and agree on a fix and disclosure timeline.

## In scope

The server (model API, relay/WebSocket, MCP endpoint and OAuth, authentication),
the web dashboard, the `wsmp` CLI and self-update, and the container images.

## Supported versions

Only the 1.0.x release line is supported. Versions 0.4.x and earlier are unsupported.

## Security controls

- pnpm supply-chain hardening: release-age gate, exotic-subdependency
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
- MCP OAuth scope policy on top of Better Auth's provider: an authorize request
  must name its scopes (Better Auth would otherwise default to every scope the
  client registered, better-auth#12194), and consent, refresh and the agent
  grant can only narrow them. Known, accepted gap: dynamic client registration
  is narrowed to the requested scopes in a second write after Better Auth has
  stored the client with the whole ceiling. If that write fails, wsmp tries to
  delete the client and answers 500. A crash in between, or a failed deletion,
  leaves a client whose `client_id` and secret were never returned. It still needs a person's consent and PKCE,
  and the cleanup sweep removes it after 24 hours. See
  [docs/mcp.md](docs/mcp.md#client-registration-cimd--dynamic-registration).
- Sharing a pool or runtime definition by e-mail shares directly only with an
  account whose mailbox the verify-email flow proved; any other address gets an
  invite that needs its link. Known, deliberate behavior: because the answer
  differs, a signed-in person who shares can learn whether an address belongs
  to an account with a proved e-mail. An unproved account and an unknown
  address get the same answer.
- No account-existence oracle on the anonymous auth endpoints: with SMTP
  configured, sign-up, resend verification, the password-reset request and a
  wrong-password sign-in answer byte-identically (status, headers, body) for an
  unknown, an unverified and a verified address. Sign-up needs the app's help
  (`packages/auth/src/signup-response.ts`). Better Auth answers a registered
  address with a synthetic user whose `role` and `slug` are null, so every
  success body is replaced with `{"token":null,"user":null}`. Only a free
  address goes on to user creation, so anything that refuses it there (an
  invite link whose claim is in use, a database refusal, a slug race) gets that
  same neutral 200, unless no account exists yet (the first-admin bootstrap),
  and an invite claim it made is released. A requested slug another account
  holds, and a NUL byte in a stored field, are refused before the address
  lookup, the same answer for every address. Verification mail (sign-up,
  resend, sign-in re-send) is sent in the background, so SMTP latency or a
  failure never shows in the response. Known, deliberate differences: without
  SMTP an account is usable at once, so sign-up signs a free address in and
  tells a registered one it is taken; the right password on an unverified
  account answers `EMAIL_NOT_VERIFIED` and re-sends the link; and a sign-up of a
  free address creates that account (and mails it), so it can only show that
  the address *was* free (a later sign-in, the extra time the new account costs).

See `AGENTS.md` for the guardrails an AI coding agent must respect when
working in this repo.

## SSR and rendered content

The dashboard does not render user-authored or CMS Markdown/HTML. Its only
`dangerouslySetInnerHTML` usage is the repository-owned theme bootstrap string,
authorized by a matching CSP hash. TanStack Start hydration scripts receive a
per-request CSP nonce. If untrusted rich text is introduced later, it must be
sanitized before rendering and the CSP must not be weakened to accommodate it.
