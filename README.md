<a href="https://github.com/FlyCockpit/ws-model-proxy">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="https://shieldcn.dev/header/graph.svg?title=WS+Model+Proxy&subtitle=Self-hosted+OpenAI-compatible+model+routing+through+outbound+websockets&logo=websocket&size=wide&theme=cyan&mode=light&align=left">
    <img src="https://shieldcn.dev/header/graph.svg?title=WS+Model+Proxy&subtitle=Self-hosted+OpenAI-compatible+model+routing+through+outbound+websockets&logo=websocket&size=wide&theme=cyan&mode=dark&align=left" alt="WS Model Proxy">
  </picture>
</a>

<p align="center">
  <a href="https://github.com/FlyCockpit/ws-model-proxy/stargazers"><img alt="GitHub stars" src="https://shieldcn.dev/github/stars/FlyCockpit/ws-model-proxy.svg?variant=secondary&mode=light&size=sm"></a>
  <a href="https://github.com/FlyCockpit/ws-model-proxy/blob/master/LICENSE"><img alt="License" src="https://shieldcn.dev/github/license/FlyCockpit/ws-model-proxy.svg?variant=secondary&mode=light&size=sm"></a>
  <a href="https://github.com/FlyCockpit/ws-model-proxy/commits/master"><img alt="Last commit" src="https://shieldcn.dev/github/last-commit/FlyCockpit/ws-model-proxy.svg?variant=secondary&mode=light&size=sm"></a>
  <a href="apps/cli/Cargo.toml"><img alt="Rust CLI" src="https://shieldcn.dev/badge/cli-wsmp-ef7d00.svg?variant=secondary&mode=light&size=sm&logo=rust"></a>
</p>

# WS Model Proxy

Self-hosted web app plus CLI for exposing locally hosted OpenAI-compatible model endpoints through a VPS without router port forwarding.

## Current Direction

- Deploy one Docker web app on a VPS.
- The first signed-up user becomes admin automatically.
- Later users are regular users unless promoted by an admin.
- Admins can enable or disable open signup.
- Auth works with email/password even when SMTP is not configured. When SMTP
  is configured, email verification is required and the full verification UX
  (safe callback URLs, resend, localized mail) is enabled.
- The `wsmp` CLI authenticates with device auth or an API token, then holds an outbound websocket connection to the server.
- A single CLI instance can forward to multiple local or network model endpoints.
- Request images are forwarded through the proxy request and not stored by the app.

## Runtime Shape

- `apps/web`: React/TanStack Router web dashboard.
- `apps/server`: Hono API/server entrypoint.
- `apps/cli`: Rust CLI workspace for the websocket relay client.
- `packages/api`: oRPC routers and procedures.
- `packages/auth`: Better Auth configuration.
- `packages/db`: Prisma schema/client.
- `packages/env`: environment validation.
- `packages/ui`: shared UI components.

The runtime is intentionally reduced to the product web service, CLI, Postgres, Better Auth, i18n, and the PWA shell.

## Local Development

```sh
pnpm install
pnpm dev:services
pnpm db:validate
pnpm db:push
pnpm dev
```

### Environment files

Root `.env.example` and `apps/web/.env.example` are **generated** from
`scripts/lib/env-manifest.ts`. Do not hand-edit them.

```sh
pnpm env:sync          # rewrite the .env.example files from the manifest
pnpm env:check         # CI gate: schema keys, manifest, and examples stay in sync
pnpm generate:secrets  # interactive production env block (WMP vars only)
pnpm docker:check-copy # CI gate: Dockerfile COPY lists match workspace members
```

`pnpm generate:secrets` prompts for deploy target, generates
`BETTER_AUTH_SECRET`, and collects only variables that apply to this repo
(no Redis, S3, CMS, VAPID, or worker knobs). Use `--all` to include rate-limit
tuning comments, or `--out <file>` to write a gitignored file.

Email is optional: without SMTP, signup/login work and verification is off.
With SMTP configured, email verification is required and verification mail,
password-reset mail (when used), and email 2FA OTP are available.

Useful checks:

```sh
pnpm db:validate
pnpm check-types
pnpm --filter web check-types
pnpm test
pnpm env:check
pnpm docker:check-copy
pnpm policy:auth-session
```

## Publishing and Runtime

Releases are created manually from the `master` branch with the root `Release` GitHub Actions workflow. A release publishes:

- The app container to GHCR.
- Cross-platform `wsmp` CLI artifacts to the GitHub Release.
- The generated Homebrew formula to `FlyCockpit/homebrew-tap`.

Before the first release, create a protected `release` environment and add `HOMEBREW_TAP_TOKEN` as an environment secret. It must have `contents:write` access to `FlyCockpit/homebrew-tap` so the release workflow can update `Formula/wsmp.rb`.

Install the CLI with Homebrew after the first release:

```sh
brew install flycockpit/tap/wsmp
```

Alternative CLI installers are attached to each GitHub Release:

```sh
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/FlyCockpit/ws-model-proxy/releases/latest/download/wsmp-installer.sh | sh
```

```powershell
irm https://github.com/FlyCockpit/ws-model-proxy/releases/latest/download/wsmp-installer.ps1 | iex
```

The app image is published as:

```text
ghcr.io/flycockpit/ws-model-proxy:vX.Y.Z
ghcr.io/flycockpit/ws-model-proxy:X.Y.Z
ghcr.io/flycockpit/ws-model-proxy:sha-<commit-sha>
ghcr.io/flycockpit/ws-model-proxy:latest   # when publish_latest is true
```

For example:

```sh
docker pull ghcr.io/flycockpit/ws-model-proxy:latest
```

The runtime is a single web service container plus Postgres. No Redis, S3/R2 object storage, VAPID push service, CMS/MCP service, video pipeline, docs app, or separate queue process is required in v1.

Required production values:

- `DATABASE_URL`: Postgres connection string.
- `BETTER_AUTH_SECRET`: 32+ byte random secret. Model API tokens, CLI tokens, durable device credentials, and Responses API sticky-routing digests derive purpose-specific HMAC keys from this value. Rotating it invalidates those credentials and sticky mappings.
- `BETTER_AUTH_URL`: public HTTPS app URL.
- `NODE_ENV=production`.

Optional values include SMTP settings (enables verification, password reset, and email 2FA delivery), `SIGNUP_ENABLED`, rate-limit settings (including per-recipient email caps), and display/build values such as `VITE_APP_NAME`, `VITE_SERVER_URL`, and `BUILD_VERSION`. Prefer `pnpm generate:secrets` over hand-editing production env.

Schema sync is handled by the server container entrypoint with `APPLY_SCHEMA=off|safe|dangerous`; keep it `off` for normal deploys and use `safe` for additive schema deploys.

CLI operator flow:

1. Deploy the web service and Postgres.
2. Create the first admin user, or configure admin emails before inviting operators.
3. Install `wsmp` with `brew install flycockpit/tap/wsmp`.
4. Create a device login or CLI token from the dashboard.
5. Configure the CLI's local JSON endpoint inventory.
6. Run `wsmp connect` or the equivalent daemon command from the machine that can reach the local model endpoints.

Model API clients call `/v1/*` with `Authorization: Bearer ...`. Cookie/session auth and permissive browser CORS are intentionally not supported for those bearer routes in v1.

## License

MIT. See [LICENSE](./LICENSE).
