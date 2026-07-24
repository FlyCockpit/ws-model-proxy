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
wsmp completions zsh                # shell completions
```

Configuration is stored in a TOML file. `wsmp config path` prints the resolved path for the current platform. Logs go to stderr; pass `-v`/`-vv` for more, `--quiet` for less, or set `WSMP_LOG`.

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
