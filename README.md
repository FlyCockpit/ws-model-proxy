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

Self-hosted web app plus a node client (`wsmp`) that serves the models running on your own
computers through one OpenAI-compatible API on a VPS, without router port forwarding.

- **Nodes** are computers running `wsmp`. Each keeps one outbound websocket to the server and
  gives it one trust level: **Full control** (the server may define and start runtimes, run
  commands, edit files and open terminals there) or **Relay only** (it only relays requests to
  the runtimes the node already holds, which people can still start and stop).
- **Runtimes** are inference server definitions: **always-on** (an address on a node that is
  just there) or **startable** (commands that start it on one or more nodes, from a preset such
  as vLLM (chat, embeddings or speech-to-text), SGLang, llama.cpp or Docker Compose). Every edit is a new version; a start previews the placement
  (free memory, ports, labels) before you confirm. **Profiles** switch a set of nodes between
  runtime versions in one click.
- **Pools** are what clients call: `owner/pool` routes to served models of your runtimes (and of
  people who contribute theirs), and `owner/pool:external` may also use cloud **providers** under
  a monthly cap when local runtimes are busy. Pools can be shared by e-mail; a person you share
  with can use the pool, contribute their own runtimes to it, or both, and either side can stop.
- **Agents** connect over MCP (OAuth or an agent token, Read-only or Full). With Full they can
  define, start and stop runtimes and manage pools; raising a node's trust, provider accounts
  and Forget stay with people.

WMP keeps content-free usage and routing metadata, never chat content. Native Responses defaults
to `store: false`; backend storage requires explicit caller opt-in. External embeddings need an
exact vector-space contract. See [external fallback](docs/external-fallback.md).

## Current Direction

- Deploy one Docker web app on a VPS.
- In local development and tests, the first signed-up user becomes admin automatically.
- On a fresh production database with public signup disabled, only `ADMIN_EMAIL` may bootstrap the first admin.
- Later users are regular users unless promoted by an admin.
- Admins can enable or disable open signup. Admin invites still work when open signup is closed.
- Auth works with email/password even when SMTP is not configured. When SMTP
  is configured, email verification is required and the full verification UX
  (safe callback URLs, resend, localized mail) is enabled.
- A node logs in once with `wsmp login` and a one-time enrollment code from the **Nodes** page,
  then holds an outbound websocket connection to the server.
- One node can hold many runtimes, and a multi-node runtime spans several nodes.
- Request media passes through the proxy. With upload storage configured, chat attachments are
  kept only for the retention window an admin sets (Admin → Settings).

## Runtime Shape

- `apps/web`: React/TanStack Router web dashboard.
- `apps/server`: Hono API/server entrypoint.
- `apps/cli`: Rust workspace for `wsmp`, the node client.
- `packages/api`: oRPC routers and procedures.
- `packages/auth`: Better Auth configuration.
- `packages/db`: Prisma schema/client.
- `packages/env`: environment validation.
- `packages/ui`: shared UI components.

The runtime is intentionally reduced to the product web service, CLI, Postgres, Better Auth, i18n, and the PWA shell.

An MCP (Model Context Protocol) server exposes dashboard operations to OAuth-authenticated clients. It is on by default; set `WMP_MCP_ENABLED=false` to close it — see [docs/mcp.md](docs/mcp.md).

## Local Development

```sh
pnpm install
pnpm dev:services
pnpm db:validate
pnpm db:push
pnpm dev
```

Use the repository `pnpm db:push` wrapper for every schema application. It
runs Prisma and then installs the database constraints/backfills in
`packages/db/prisma/schema-hardening.sql`; invoking raw `prisma db push` alone
is unsupported.

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
- Cross-platform `wsmp` CLI archives to the GitHub Release, with a `sha256.sum` checksum file and signed build-provenance attestations (`gh attestation verify <archive> --repo FlyCockpit/ws-model-proxy`). The workflow refuses to publish when a Linux or macOS archive or its checksum is missing.
- The generated Homebrew formula to `FlyCockpit/homebrew-tap`.

Before the first release, create a protected `release` environment and add `HOMEBREW_TAP_TOKEN` as an environment secret. It must have `contents:write` access to `FlyCockpit/homebrew-tap` so the release workflow can update `Formula/wsmp.rb`.

> **This server needs wsmp 0.4.0 or newer** (relay protocol 3.0). Until 0.4.0 is released, `releases/latest` and Homebrew still serve 0.3.x, which the server refuses at connect, and the server's `/install.sh` builds `wsmp` from source with cargo: the `redesign-0.4.0` branch, or the commit in `WMP_CLI_SOURCE_REV` (recommended: the commit the server runs). Setting `WMP_CLI_RELEASE_BASE_URL` opts into the release-binary install below. You can also build from this repository: `cargo install --path apps/cli --bin wsmp`.

The usual way to install the CLI on a node is the server's own installer, which the **Add a node** dialog runs for you:

```sh
curl -fsSL https://wsmp.example.com/install.sh | sh
```

From the 0.4.0 release on, it installs the release binary of the server's version into `~/.cargo/bin` (`$CARGO_HOME/bin` when set) on Linux x86_64 and ARM64 (glibc 2.34 or newer) and macOS, after checking its SHA-256 against the release's `sha256.sum` (it refuses to install on a mismatch or a missing checksum). Other systems build the release tag from source with cargo (Rust 1.88 or newer). `WMP_CLI_RELEASE_BASE_URL` points it at a mirror of the release assets; `WMP_CLI_SOURCE_REV` makes it build that commit from source instead.

Alternatively, after the first release, install the CLI with Homebrew (remove it before using `/install.sh`, or it can shadow `~/.cargo/bin/wsmp` on your `PATH`):

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

The supported v1 runtime is exactly one web service container plus Postgres. The
auth and per-account failed-sign-in rate limits are process-local, so do not
run multiple web replicas until they are moved to a shared durable limiter.
No Redis, S3/R2 object storage, VAPID push service, CMS/MCP service, video
pipeline, docs app, or separate queue process is required in v1.

Required production values:

- `DATABASE_URL`: Postgres connection string.
- `BETTER_AUTH_SECRET`: 32+ byte random secret. API keys, agent tokens, node credentials, enrollment codes, share invites, signed media URLs and the Responses and cache-affinity routing digests derive purpose-specific HMAC keys from this value. Rotating it invalidates all of those: every node must log in again with a new enrollment code, and every API key and agent token must be recreated.
- `BETTER_AUTH_URL`: public HTTPS app URL.
- `NODE_ENV=production`.

Optional values include SMTP settings (enables verification, password reset, and email 2FA delivery), one rate-limit multiplier (`WMP_RATE_LIMIT_SCALE`, 0.1-100, scaling every built-in budget; the per-recipient email and failed-password caps are always on), and display/build values such as `VITE_APP_NAME`, `VITE_SERVER_URL`, and `BUILD_VERSION`. If `SIGNUP_ENABLED=false` on a fresh production database, set `ADMIN_EMAIL` to the sole operator address allowed to bootstrap its first admin. Case and surrounding whitespace are canonicalized before account creation. Prefer `pnpm generate:secrets` over hand-editing production env.

Schema sync is handled by the server container entrypoint with `APPLY_SCHEMA=off|safe|dangerous`; keep it `off` for normal deploys and use `safe` for additive schema deploys. Each release's notes say which setting it needs; see [`docs/release-notes/`](docs/release-notes/).

### Server requirements

- **Stop grace of at least 52 s.** On `SIGTERM` the server drains HTTP, closes relay sessions and stops its background sweeps, and exits within 47 s (`PROCESS_SHUTDOWN_DEADLINE_MS` in `apps/server/src/shutdown-timeouts.ts`). Docker's default stop grace is 10 s, which cuts that sequence short with `SIGKILL`. Use `docker stop -t 52`, compose `stop_grace_period: 52s` (the shipped `docker-compose.agent.yml` app services set it), or your platform's equivalent (for example Kubernetes `terminationGracePeriodSeconds: 52`).
- **Database sessions run in UTC.** Every Prisma connection the server opens (all application queries, including the sweepers) is forced to `TimeZone=UTC` on connect (`packages/db/src/client-factory.ts`), whatever the URL options, `PGOPTIONS`, or role/database/server defaults say. Raw-SQL clocks (`now()`, `clock_timestamp()`) are compared with `timestamp without time zone` columns written from JavaScript in UTC, so do not change `TimeZone` from application SQL.
- **No transaction-mode poolers.** PgBouncer `pool_mode=transaction` (and other transaction-mode poolers) is unsupported: session settings such as `TimeZone` and the sweeper's `statement_timeout` must persist for the life of the connection. Connect directly to Postgres or use session pooling.

Schema sync never queues behind live traffic for long. `prisma db push` runs with a 5s `lock_timeout` and is retried as a whole on a lock timeout or deadlock (`packages/db/scripts/push-schema.mjs`). Schema hardening locks every table it touches up front with `NOWAIT` and retries until it gets them all at once, and it is skipped entirely when neither `schema-hardening.sql` nor the database catalog changed since its last apply (`SCHEMA_HARDENING_FORCE=1` re-applies anyway).

Getting started (the **Get started** page walks through the same steps):

1. Deploy the web service and Postgres.
2. With public signup disabled, configure `ADMIN_EMAIL` before first use, then create the first admin from that address.
3. **Add a node**: on the **Nodes** page, choose **Add a node** and run the command it shows on
   the computer that runs (or will run) your models. It installs `wsmp` through the server's
   `/install.sh` and runs `wsmp login` with a one-time enrollment code, which asks for the trust
   level and offers to install the per-user service. See [apps/cli/README.md](apps/cli/README.md).
4. **Add a runtime**: on **Runtimes**, choose **New runtime**: a detected or always-on server
   (an address on the node), or a preset (vLLM, SGLang, llama.cpp, Docker Compose, ...) that the server starts
   for you.
5. **Create a pool** from one of the runtime's served models. Its callable ID (`you/pool`) is the
   model name clients send.
6. **Create an API key** under **Access → API keys**, and try the pool on the **Test** page.

Model API clients call `/v1/*` with `Authorization: Bearer ...`. Cookie/session auth and permissive browser CORS are intentionally not supported for those bearer routes in v1.

### OpenAI-compatible client API

Create an API key under **Access → API keys** (for all your pools or selected ones), then use
the public server URL as the OpenAI-compatible base URL. Browser login cookies do not
authenticate these routes.

```sh
export WSMP_SERVER_URL="https://models.example.invalid"
export WSMP_API_KEY="wsmp_key_…"
curl --fail-with-body \
  -H "Authorization: Bearer $WSMP_API_KEY" \
  "$WSMP_SERVER_URL/v1/models"
```

For OpenWebUI and other OpenAI-compatible clients, set the API base URL to
`$WSMP_SERVER_URL/v1` and provide the same key. The model name is a callable ID, exactly as
the **Models** page and `/v1/models` show it: `owner/pool`, or `owner/pool:external` where the
pool's cloud mode covers you. `/v1/models` lists the callable IDs this key may call. The public
API serves pools only; to try one of your served models directly, use the **Test** page.

Dedicated speech-to-text requests use `POST /v1/audio/transcriptions` (and
translations use `/v1/audio/translations`) with the standard multipart OpenAI
shape. This is protocol proxying to the transcription runtimes in the pool; it is separate
from `input_audio` inside chat requests. WMP does not run
ASR, diarization, alignment, language detection, or transcoding. It forwards
supported timestamps, diarization fields, provider extensions, response
formats, and SSE bytes unchanged, while each served model's capabilities decide which pool
members may take the request.

### Why is my model missing?

1. **Is the node online?** The **Nodes** page shows it. On the node, `wsmp status` must show a
   connected relay; if not, check `wsmp service status` and `wsmp service logs`.
2. **Does the node hold the runtime?** `wsmp runtime list` on the node lists the runtimes and
   instances it holds, with their phase. A startable runtime serves only while an instance is
   `ready`: start it from its runtime page (or apply a profile), and read why a start failed
   there or in `wsmp service logs`.
3. **Does the runtime answer?** `wsmp runtime test <slug>` sends one small request from the node
   and reports the status and latency. A runtime that does not answer there cannot serve through
   the server either. The **Test** page tries the same served model from the browser.
4. **Is it in a pool?** Clients and `/v1/models` see pools, never runtimes: add the served model
   to a pool, and check that your API key covers that pool (**Access → API keys**).

## License

MIT. See [LICENSE](./LICENSE).
