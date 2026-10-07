<a href="https://github.com/FlyCockpit/ws-model-proxy">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="https://shieldcn.dev/header/dots.svg?title=WS+Model+Proxy+CLI&subtitle=Node+client+for+WS+Model+Proxy&logo=rust&logoColor=brand&size=wide&theme=orange&mode=light&align=left">
    <img src="https://shieldcn.dev/header/dots.svg?title=WS+Model+Proxy+CLI&subtitle=Node+client+for+WS+Model+Proxy&logo=rust&logoColor=brand&size=wide&theme=orange&mode=dark&align=left" alt="WS Model Proxy CLI">
  </picture>
</a>

<p align="center">
  <a href="https://github.com/FlyCockpit/ws-model-proxy/stargazers"><img alt="GitHub stars" src="https://shieldcn.dev/github/stars/FlyCockpit/ws-model-proxy.svg?variant=secondary&mode=light&size=sm"></a>
  <a href="https://github.com/FlyCockpit/ws-model-proxy/forks"><img alt="GitHub forks" src="https://shieldcn.dev/github/forks/FlyCockpit/ws-model-proxy.svg?variant=secondary&mode=light&size=sm"></a>
  <a href="Cargo.toml"><img alt="Rust 1.88+" src="https://shieldcn.dev/badge/rust-1.88+-ef7d00.svg?variant=secondary&mode=light&size=sm&logo=rust"></a>
  <a href="#license"><img alt="License" src="https://shieldcn.dev/github/license/FlyCockpit/ws-model-proxy.svg?variant=secondary&mode=light&size=sm"></a>
</p>

> The node client for WS Model Proxy 0.4.0.

`wsmp` turns a machine into a **node** of your WS Model Proxy server. It keeps one outbound
websocket to the server (no port forwarding), relays model requests to the model servers on this
machine, and, when you allow it, runs the runtimes, commands, file operations and terminals the
server asks for.

0.4.0 speaks relay protocol 3.0 only.
A 0.3 CLI cannot connect to a 0.4.0 server, and this CLI cannot connect to a 0.3 server.

## Install

From your server:

```sh
curl -fsSL https://wsmp.example.com/install.sh | sh
```

The script installs the release binary of the server's version on Linux x86_64 and ARM64 (glibc
2.34 or newer, such as Ubuntu 22.04+ and DGX OS) and on macOS. It verifies the archive's SHA-256
against the release's `sha256.sum` and refuses to install on any mismatch or missing checksum.
On other machines, or when the server pins a commit (`WMP_CLI_SOURCE_REV`), it builds from source
with `cargo install`, which needs Rust 1.88 or newer (<https://rustup.rs>) and a C compiler.

Either way the binary lands in `~/.cargo/bin` (`$CARGO_HOME/bin` when set); add it to your `PATH`
if `wsmp` is not found.

Until the v0.4.0 release is published there is nothing to download: the script stops with
"could not download .../sha256.sum". A server running a pre-release build sets
`WMP_CLI_SOURCE_REV` to its commit so nodes build that commit from source. To check a downloaded archive yourself:

```sh
gh attestation verify wsmp-aarch64-unknown-linux-gnu.tar.xz --repo FlyCockpit/ws-model-proxy
```

Or build a release tag with cargo directly:

```sh
cargo install --git https://github.com/FlyCockpit/ws-model-proxy --tag v0.4.0 --locked wsmp
```

## Log in

On the server's **Nodes** page, create an enrollment code, then on this machine run:

```sh
wsmp login https://wsmp.example.com --code wsmp_enr_...
```

`wsmp login` asks for anything you leave out (the code can also come from `WSMP_ENROLL_CODE`).
Useful flags:

| Flag | Meaning |
| ---- | ------- |
| `--slug <name>` | This node's name. Defaults to the saved name, else one derived from the hostname. |
| `--trust full\|relay` | What the server may do here (see [Trust](#trust)). Prompted on a terminal; without one, `full`. |
| `--human-terminal on\|off` | Allow browser terminals on this node. Asked next to trust on a terminal (default yes; not asked at Relay only, where they cannot open); without a terminal, the saved setting stays (`off` unless set) and login says so. |
| `--service` / `--no-service` | Install and start the per-user service without asking, or skip it. |
| `--replace` | Confirm a Replace code (below) without the prompt. |
| `--json` | Print the result as JSON. |

**Node names** are 3 to 63 characters: lowercase letters, digits and single hyphens, starting
and ending with a letter or digit. A few names are reserved because they collide with routes
(`api`, `v1`, `admin`, `auth`, `login`, `logout`, `signup`, `settings`, `dashboard`, `health`,
`model`, `models`, `cli`, `clis`, `endpoint`, `endpoints`, `pool`, `pools`, `token`, `tokens`).
Names are unique per account; a name that is taken is refused (`slug_taken`).

**Replace codes** move an existing node to this machine: same node, same runtimes and traffic,
new identity and credential (the old machine's credential stops working). Create one from the
node's page. `wsmp login` shows which node it replaces and asks you to type `yes`; pass
`--replace` to confirm non-interactively. If the replaced node was Relay only, this one starts
Relay only as well.

**Temporary nodes**: a code can mark the nodes it enrolls as temporary. The server deletes such
a node after it has been offline for the code's window (one hour unless set), and `wsmp login`
says so.

A plain code never takes over an existing node, even on the same machine: log in again with a
new code and a new name, or use a Replace code.

## Run the relay

```sh
wsmp service install     # install, enable and start the per-user service
wsmp service status      # what the service manager reports
wsmp service uninstall   # stop, disable and remove it
wsmp status              # whether the relay runs and is connected
wsmp run                 # run the relay in the foreground (what the service runs)
wsmp logout              # forget this node's credential
```

The service is a systemd user unit on Linux and a launchd agent on macOS. `wsmp service
env-sync` and `wsmp service env-path` manage the private (0600) environment file the service
reads; the node credential needs no entry there.

**Linux: enable lingering.** A user service stops when you log out, and runtimes are started as
transient user units, which need a user manager that outlives your sessions. Enable it once:

```sh
loginctl enable-linger $USER
```

Without linger the node refuses to start runtimes (the server shows why); relaying to model
servers that already run still works.

## Trust

Each node gives the server one of two levels. You choose at login and can change it any time.

- **Full control** (default): the server may define and start runtimes, run commands, read and
  write files inside the folders you allow (`wsmp config set-file-roots`), open terminals, and
  set node secrets.
- **Relay only**: the server may only send requests to model servers here and start or stop the
  runtimes this node already holds. Definitions are frozen at the moment you lower trust; nothing
  new can be defined, run or read. Lowering also stops node commands that are running.

```sh
wsmp trust          # show the current level
wsmp trust relay    # lower: works from anywhere, takes effect at once
wsmp trust full     # raise: needs you at this machine's terminal
```

`wsmp trust full` asks you to type `full`, takes no `--yes` flag and no environment override, and
refuses to run from any process the relay started (its commands, jobs and terminals). This is a
**best-effort guard against agents** raising their own access through the server. It is **not a
security boundary against other code running as your user**: anything that runs as you can edit
your files, including this CLI's configuration. If you do not trust the code on this account,
Relay only does not make it safe.

## Secrets

Runtimes and model servers often need tokens. Node secrets are named `WSMP_SECRET_` followed by
1 to 64 of `A-Z`, `0-9` and `_`. Values stay on this machine; the server only ever sees names.

```sh
wsmp secret set WSMP_SECRET_HF_TOKEN   # the value is typed at a hidden prompt
wsmp secret list                       # names and when they were set, never values
wsmp secret remove WSMP_SECRET_HF_TOKEN
```

`wsmp secret` works at either trust level (it is how a Relay-only node gets secrets) and, like
`wsmp trust full`, only from a person's terminal. At Full control the server can also set them.
A runtime names the secrets its commands receive in `launch.secrets`; a model server's address
can use one for its auth header.

## Commands and runtimes

The server asks a node to do two different kinds of work:

- **Runtimes** are definitions the server stores and versions: an always-on model server already
  running here, or a startable one (or a service) with start, stop, readiness and health
  commands. The server sends the definitions to the node, then starts and stops instances by
  version; the node renders each command from the definition it holds, so a start never runs
  text it was not given in a definition. At Relay only, the held definitions are frozen and can
  still be started and stopped.
- **Commands** are one-off shell commands a person or an agent runs here through the server
  (inspect a GPU, pull a model). They need Full control, run as your user, are recorded in the
  node's activity, and stop when trust is lowered. An agent can also queue a command for you
  (one that needs a password, for example); it runs only when you choose Run on the Terminals
  page.

## Other commands

| Command | What it does |
| ------- | ------------ |
| `wsmp config path\|init\|show` | Where the config lives, create it, print it. |
| `wsmp config set-server <url> [--public-origin <origin>]` | Point at another server address (restart to apply). |
| `wsmp config set-slug <name>` | Change the saved node name. |
| `wsmp config set-file-roots <dir>...` / `clear-file-roots` | Folders the file tools may use. |
| `wsmp config set-runtime-hosts [host...]` | Extra hosts an always-on runtime may use besides loopback. |
| `wsmp config set-human-terminal on\|off` | Allow browser terminals (the same setting `wsmp login` asks about). |
| `wsmp config set-terminal-approval on\|off` | Require approval before a browser opens a terminal. |
| `wsmp config set-max-terminals <1-32>` | Cap browser terminals open at once. |
| `wsmp config set-file-tools-as-root on\|off` | Allow the file tools when wsmp runs as root. |
| `wsmp terminal fingerprint` | This node's terminal identity, as browsers show it. |
| `wsmp terminal approve <code>` / `approvals list\|revoke` | Manage approved browser identities. |
| `wsmp recover [--apply] [--scan]` | List or finish interrupted file writes ([guide](docs/file-recovery.md)). |
| `wsmp completions <shell>` | Shell completion scripts. |

Commands that print data take `--json` (`wsmp service` does not). Logs go to stderr (`-v`, `-vv`, `-q`,
`--log-format json`).

## Exit Codes

| Code | Meaning |
| ---- | ------- |
| 0 | success |
| 1 | runtime error |
| 2 | usage error |
| 3 | not found |
| 4 | the relay has no usable credential (none saved, or the server rejected it with HTTP 401); run `wsmp login`. Only under the systemd unit and in an interactive terminal; elsewhere the relay retries instead. The systemd unit does not restart on this code. |
| 128 + signal | the relay stopped on SIGHUP (129), SIGINT (130), or SIGTERM (143); on Unix it dies from that signal after cleanup |

## Development

```sh
cargo build
cargo test --workspace --all-targets --locked
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo fmt
```

Before considering a change done, run the full local gate:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets --locked
cargo test --workspace --doc --locked
cargo xtask sync-docs --check
```

The relay protocol is shared with the server through the fixtures in
`tests/fixtures/relay-3.0`; the contract is described in `docs/contracts/0.4.0.md` at the
repository root. See [AGENTS.md](AGENTS.md) for conventions and [CONTRIBUTING.md](CONTRIBUTING.md)
for the PR checklist.

## Guides

- [Error handling](docs/error-handling.md)
- [File recovery](docs/file-recovery.md)
- [Releasing](docs/releasing.md)

## Agent Docs

`AGENTS.md` is the source of truth for CLI contributor and agent instructions. `CLAUDE.md` and
`.cursorrules` are generated mirrors. Edit `AGENTS.md`, then run `cargo xtask sync-docs`.

## License

MIT. See [LICENSE-MIT](LICENSE-MIT).
