<a href="https://github.com/FlyCockpit/ws-model-proxy">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="https://shieldcn.dev/header/dots.svg?title=WS+Model+Proxy+CLI&subtitle=Outbound+relay+client+for+local+LLM+endpoints&logo=rust&logoColor=brand&size=wide&theme=orange&mode=light&align=left">
    <img src="https://shieldcn.dev/header/dots.svg?title=WS+Model+Proxy+CLI&subtitle=Outbound+relay+client+for+local+LLM+endpoints&logo=rust&logoColor=brand&size=wide&theme=orange&mode=dark&align=left" alt="WS Model Proxy CLI">
  </picture>
</a>

<p align="center">
  <a href="https://github.com/FlyCockpit/ws-model-proxy/stargazers"><img alt="GitHub stars" src="https://shieldcn.dev/github/stars/FlyCockpit/ws-model-proxy.svg?variant=secondary&mode=light&size=sm"></a>
  <a href="https://github.com/FlyCockpit/ws-model-proxy/forks"><img alt="GitHub forks" src="https://shieldcn.dev/github/forks/FlyCockpit/ws-model-proxy.svg?variant=secondary&mode=light&size=sm"></a>
  <a href="Cargo.toml"><img alt="Rust 1.85+" src="https://shieldcn.dev/badge/rust-1.85+-ef7d00.svg?variant=secondary&mode=light&size=sm&logo=rust"></a>
  <a href="#license"><img alt="License" src="https://shieldcn.dev/github/license/FlyCockpit/ws-model-proxy.svg?variant=secondary&mode=light&size=sm"></a>
</p>

> Command-line relay client for WS Model Proxy.

The `wsmp` CLI authenticates with the web app, holds an outbound websocket connection to the server, and forwards local or network OpenAI-compatible model endpoints without router port forwarding.

## Start Here

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets --locked
cargo test --workspace --doc --locked
cargo xtask sync-docs --check
```

## What You Get

- A clap-based CLI with config, auth, endpoint inventory, probing, and relay commands.
- Clean stdout/stderr boundaries, JSON output support, structured logging, and stable process exit codes.
- Cross-platform config/state paths and TOML config load/save helpers.
- Focused black-box CLI tests plus unit tests next to pure logic.
- CI for fmt, clippy, tests, docs drift, dependency policy, typos, MSRV, and lightweight repository policy checks.
- Cross-platform releases through `dist`, including shell, PowerShell, and Homebrew installer artifacts.

## CLI

```sh
wsmp login                         # start device-code login
wsmp token login WSMP_TOKEN         # store the env var name for a CLI token
wsmp config path                    # where the config file lives
wsmp config --json show             # print config as JSON
wsmp config init                    # write a default config
wsmp config set-slug desk-01        # set this CLI connection's slug
wsmp endpoints add local http://127.0.0.1:11434
wsmp endpoints add local http://127.0.0.1:11434 --expand-media  # inline WMP media URLs
wsmp endpoints probe local
wsmp connect                        # open the outbound websocket relay
wsmp daemon start --detach          # background relay (new session; owns a PID file)
wsmp daemon status                  # inspect the live relay (non-zero if absent)
wsmp status                         # top-level live relay status alias
wsmp reload                         # probe and publish the complete inventory; waits for server ack
wsmp reload --offline               # probe and save local state only; never publishes
wsmp daemon stop                    # stop a detached relay
wsmp service install                # install, enable, and start a Linux/macOS user service
wsmp service status                 # inspect the installed user service
wsmp service env-sync               # copy required env vars into the private service env file
wsmp completions zsh                # shell completions
```

Configuration is stored in a JSON file. `wsmp config path` prints the resolved path for the current platform. Logs go to stderr; pass `-v`/`-vv` for more, `--quiet` for less, or set `WSMP_LOG`.

### Background daemon and user services

- `wsmp daemon start --detach` starts a session-detached relay that owns
  `$WSMP_STATE_DIR/relay.pid` (with a pid + ownership token). Only that detached
  process claims the PID file; foreground `wsmp connect` / `wsmp daemon start`
  and OS services do not. `wsmp status` communicates with the live relay control
  socket, so it also sees foreground and service-managed relays; it exits
  non-zero when no live acknowledged relay is available. `stop` refuses to signal a PID that no longer looks
  like this CLI's daemon (PID-reuse guard).
- The live control socket is Unix-only: it is private to the state directory
  and verifies the connecting process has the daemon's UID using OS peer
  credentials. Windows does not expose this control plane yet. On Windows,
  `wsmp reload --offline` is the explicit safe fallback: it probes and saves
  local state, then reports `published: false`; run the relay on Unix and use
  its live `wsmp reload` to publish. It requires an
  authenticated named-pipe equivalent before it can be supported safely.
- `wsmp service install` installs a **per-user** systemd unit (Linux) or
  LaunchAgent (macOS). Re-running install rewrites the unit/plist and restarts.
- **Device credentials** (`wsmp login`) live in the state directory and work
  under services without extra setup.
- **CLI tokens and endpoint header secrets** are env-var *names* in config, not
  values. User services do not inherit your interactive shell, so export those
  variables and run `wsmp service env-sync` to write them into the private
  `service.env` file (mode `0600` under the config dir). Installers load that
  file via systemd `EnvironmentFile=` or a macOS wrapper script — secrets are
  never embedded in unit/plist files and never printed. `wsmp service env-path`
  prints the file path.
- Linux tip: `loginctl enable-linger "$USER"` keeps a user service running after
  logout.

### Media expansion for local upstreams

The relay normally forwards request bodies untouched, so a signed
`{server}/media/{id}` URL in a chat request is fetched by the upstream model
server. Many local OpenAI-compatible servers (llama.cpp, LM Studio, some vLLM
builds) cannot fetch remote URLs and only accept base64 `data:` URLs.

Opt in per endpoint with `expandMedia` (config key) or `--expand-media` on
`endpoints add`. When enabled, the relay buffers chat-shaped JSON request bodies
(`Content-Type: application/json`), walks `image_url` / `video_url` /
`input_audio` content parts, fetches each media URL, and inlines it as a
`data:{mime};base64,…` URL before forwarding upstream. Still-image `image_url`
parts are normalized to JPEG/PNG when inlined (WebP/GIF and other non-safe
formats are re-encoded to JPEG) so local vision servers that reject WebP still
work. Video/audio keep their stored mime. Non-JSON bodies and body-less
requests always take the untouched streaming path.

Multipart `/v1/audio/transcriptions` and `/v1/audio/translations` requests are
also relayed to the selected OpenAI-compatible upstream. These dedicated ASR
operations are independent of chat `input_audio`; capability metadata should
describe each separately. Advanced transcription behavior (streaming,
timestamps, diarization, languages, formats, and accepted MIME types) belongs
to the upstream and is forwarded without transcript normalization.

Each upstream request has three backend-neutral timeout layers: a 10-second
connection timeout, a 30-second response-body idle timeout (reset after every
received chunk), and the operation timeout sent by the WMP server. Pool retries
share one server-side operation deadline; adding members does not multiply it.

### Reasoning capability metadata

Capability inventories at version 3 or 4 may declare `reasoningConfig` on a
surface when its native reasoning ladder and encoding are known. Omit it when
they are unknown; `reasoning: true` remains the routing gate. Upgrade the WMP
server before publishing this optional field, because older servers reject it
as an unknown capability property.

Only URLs whose origin matches the connected WMP server (derived from
`serverUrl`) and whose path is `/media/{id}` are fetched — arbitrary URLs from
request bodies are never followed (SSRF guard). Add extra trusted origins with
the `mediaTrustedOrigins` config array. The media fetcher follows no redirects,
so a trusted origin cannot 30x-redirect the relay to an arbitrary internal URL
after the origin check. Each individual asset fetch is capped at 64 MiB, and the
buffered body (with its base64-inflated result) is capped at 256 MiB overall;
over-cap or failed fetches return an OpenAI-shaped relay error naming the media
path (never the URL signature).

### Exit Codes

| Code | Meaning |
| ---- | ------- |
| 0 | success |
| 1 | runtime error |
| 2 | usage error |
| 3 | not found |

## Install After Release

These commands work after the first public GitHub release.

**Shell:**

```sh
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/FlyCockpit/ws-model-proxy/releases/latest/download/wsmp-installer.sh | sh
```

**PowerShell:**

```powershell
irm https://github.com/FlyCockpit/ws-model-proxy/releases/latest/download/wsmp-installer.ps1 | iex
```

**Homebrew:**

```sh
brew install flycockpit/tap/wsmp
```

**From source:**

```sh
git clone https://github.com/FlyCockpit/ws-model-proxy
cd ws-model-proxy
cargo install --path apps/cli --bin wsmp
```

## Development

```sh
cargo build
cargo test --workspace --all-targets --locked
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo fmt
cargo run -- config path
```

Before considering a change done, run the full local gate:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets --locked
cargo test --workspace --doc --locked
cargo xtask sync-docs --check
```

See [AGENTS.md](AGENTS.md) for repository conventions and [CONTRIBUTING.md](CONTRIBUTING.md) for the PR checklist.

## Guides

- [Error handling](docs/error-handling.md)
- [Releasing](docs/releasing.md)

## Project Layout

```text
src/
  lib.rs         shared implementation modules
  main.rs        entry: parse -> log -> dispatch -> exit code
  cli.rs         clap argument definitions
  commands/      one file per subcommand
  config.rs      TOML config load/save
  state.rs       local auth and relay state
  daemon.rs      websocket relay session
  probe.rs       endpoint/model probing
  paths.rs       cross-platform config/data dirs
  logging.rs     tracing setup; logs go to stderr
  exit.rs        stable exit codes
tests/cli.rs     black-box CLI tests
xtask/           project automation: sync-docs
docs/            error handling and release notes
tap/             notes for publishing a Homebrew tap
```

## Agent Docs

`AGENTS.md` is the source of truth for CLI contributor and agent instructions. `CLAUDE.md` and `.cursorrules` are generated mirrors. Edit `AGENTS.md`, then run:

```sh
cargo xtask sync-docs
```

Do not hand-edit generated mirrors. Release orchestration lives in the root `.github/workflows/release.yml`.

## License

MIT. See [LICENSE-MIT](LICENSE-MIT).
