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

`wsmp` turns a computer into a **node** of your WS Model Proxy server. It keeps one outbound
websocket to the server (no port forwarding), relays model requests to the runtimes on this
node, and, when you allow it, runs the runtimes, commands, file operations and terminals the
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
On other systems, or when the server pins a commit (`WMP_CLI_SOURCE_REV`), it builds from source
with `cargo install`, which needs Rust 1.88 or newer (<https://rustup.rs>) and a C compiler.

Either way the binary lands in `~/.cargo/bin` (`$CARGO_HOME/bin` when set); add it to your `PATH`
if `wsmp` is not found.

Until v0.4.0 is released, a server's script builds from source by default: the
`redesign-0.4.0` branch, or the commit in `WMP_CLI_SOURCE_REV`. The server opts into release
binaries with `WMP_CLI_RELEASE_BASE_URL`; from the release on, that is the default. To check a
downloaded archive yourself:

```sh
gh attestation verify wsmp-aarch64-unknown-linux-gnu.tar.xz --repo FlyCockpit/ws-model-proxy
```

Or build a release tag with cargo directly:

```sh
cargo install --git https://github.com/FlyCockpit/ws-model-proxy --tag v0.4.0 --locked wsmp
```

## Log in

On the server's **Nodes** page, create an enrollment code, then on this computer run:

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
| `--yes`, `-y` | Ask nothing and take the defaults: the saved or hostname node name, and installing the service (unless `--no-service`). It never makes a security choice for you: it needs `--trust`, browser terminals stay as saved (`off` unless set) unless you pass `--human-terminal on`, and a Replace code still needs `--replace`. |
| `--json` | Print the result as JSON. |

**Node names** are 3 to 63 characters: lowercase letters, digits and single hyphens, starting
and ending with a letter or digit. A few names are reserved because they collide with routes
(`api`, `v1`, `admin`, `auth`, `login`, `logout`, `signup`, `settings`, `dashboard`, `health`,
`model`, `models`, `cli`, `clis`, `endpoint`, `endpoints`, `pool`, `pools`, `token`, `tokens`).
Names are unique per account; a name that is taken is refused (`slug_taken`).

**Replace codes** move an existing node to this computer: same node, same runtimes and traffic,
new identity and credential (the old computer's credential stops working). Create one from the
node's page. `wsmp login` shows which node it replaces and asks you to type `yes`; pass
`--replace` to confirm non-interactively. If the replaced node was Relay only, this one starts
Relay only as well.

**Temporary nodes**: a code can mark the nodes it enrolls as temporary. The server deletes such
a node after it has been offline for the code's window (one hour unless set), and `wsmp login`
says so.

A plain code never takes over an existing node, even on the same computer: log in again with a
new code and a new name, or use a Replace code.

Logging in over an earlier enrollment for another server, or over leftovers of wsmp 0.3, is a
fresh enrollment: `--trust` (or your answer) applies and the old node name is not reused (you are
asked for a name, or it comes from the hostname). A node you lowered to Relay only stays Relay
only when you log in to the same server again; raise it with `wsmp trust full`. A Relay-only
setting left by an earlier enrollment is kept too, unless this fresh enrollment explicitly chooses
Full control (`--trust full`, or choosing it at the prompt): that clears it, and `wsmp login`
says so. It is not cleared while a relay is running here; stop it first.

## Run the relay

```sh
wsmp service install     # install, enable and start the per-user service
wsmp service status      # what the service manager reports
wsmp service restart     # restart it (after `wsmp login`, or to apply a setting read at start)
wsmp service logs        # its logs; -f to follow, -n <lines> (default 100)
wsmp service uninstall   # stop, disable and remove it
wsmp status              # whether the relay runs and is connected, plus its runtimes and instances
wsmp hardware            # what this node detects (memory, GPUs, unified pool); --json
wsmp run                 # run the relay in the foreground (what the service runs)
wsmp logout              # forget this node's credential
```

`wsmp hardware` shows what placement falls back to when no hardware is declared: NVIDIA GPUs
(a GB10 with no dedicated VRAM makes the node unified), AMD GPUs from sysfs (an APU such as Strix
Halo reports VRAM carve-out plus GTT as its pool), and Apple silicon (the GPU wired limit). Check
it before declaring overrides on the node's page in the web app (or through MCP); hardware is
never declared on the node itself.

The service is a systemd user unit on Linux and a launchd agent on macOS. It needs no
environment file: the node credential and node secrets (`wsmp secret`) are files the relay reads
itself, and the unit pins only the config and state paths and the installing shell's `PATH`.
`wsmp service logs` reads journald on Linux (`journalctl --user -u wsmp.service`; on a host whose
journal is not persistent, user units may log only to the system journal, which needs
`journalctl --user-unit wsmp.service` with journal read access) and tails
`~/Library/Logs/ws-model-proxy/relay.*.log` on macOS. Upgrading from 0.3: run `wsmp service
install` again so the unit stops loading `service.env`, then delete that file.

**Linux: enable lingering.** A user service stops when you log out, and runtimes are started as
transient user units, which need a user manager that outlives your sessions. Enable it once:

```sh
loginctl enable-linger $USER
```

Without linger the node refuses to start runtimes (the server shows why); relaying to always-on
runtimes still works.

## Trust

Each node gives the server one of two levels. You choose at login and can change it any time.

- **Full control** (default): the server may define and start runtimes, run commands, read and
  write files in your home directory or the folders you allow (`wsmp config set-file-roots`;
  wsmp's own files stay off limits), open terminals, and
  set node secrets.
- **Relay only**: the server may only send requests to runtimes here and start or stop the
  runtimes this node already holds. Definitions are frozen at the moment you lower trust; nothing
  new can be defined, run or read. Lowering also stops node commands that are running.

```sh
wsmp trust          # show the current level
wsmp trust relay    # lower: works from anywhere, takes effect at once
wsmp trust full     # raise: needs you at this node's terminal
```

`wsmp trust full` asks you to type `full`, takes no `--yes` flag and no environment override, and
refuses to run from any process the relay started (its commands, jobs, runtimes and terminals).
It counts as started by wsmp when it or an ancestor carries `WSMP_JOB`, runs in one of wsmp's
cgroups (`wsmp.service`, `wsmp-*` units, `wsmp_i_*` runtime slices, `systemd-run` transient
units), descends from a running relay, runs as a service of your systemd user manager
(`systemd-run --user --unit=…`), or cannot be traced back to your systemd user manager or a login
session (so cron, at and system services such as cloud-init are refused). A shell in a terminal,
tmux or an SSH session passes; a terminal that a user service runs (some compositors, editors)
does not, so use another terminal or SSH. `wsmp login` refuses only on `WSMP_JOB`, so it works
from provisioning, but clearing an earlier Relay-only setting takes this check, and from a process
that fails it login skips installing the service and turning browser terminals on (it says which
step it skipped; run `wsmp service install` or `wsmp config set-human-terminal on` on a terminal).

The same refusal covers every command that changes wsmp itself: `wsmp login`, `wsmp secret
set|remove`, the `wsmp config` setters (`init`, `set-…`, `clear-file-roots`), `wsmp service
install|uninstall|restart`, `wsmp logout`, `wsmp terminal approve` and `wsmp recover --apply`.
`wsmp run` checks only `WSMP_JOB`, since the relay's own service starts it. Reading (`wsmp config
show|path`, `wsmp service status|logs`, `wsmp runtime list|test`, listings) and lowering (`wsmp trust relay`, `wsmp
terminal approvals revoke`) work from anywhere.

This is a **best-effort guard against agents** raising or widening their own access through the
server: dropping `WSMP_JOB`, `systemd-run --user` or a crontab does not get past it. It is **not a
security boundary against other code running as your user**: such code can move itself into a
cgroup named like a terminal's, ask your tmux to run a command, `ssh` back in to this machine, or
simply edit your files, including this CLI's configuration. On Linux the relay adopts what its
commands leave behind (a `setsid` or double-forked process re-parents to it, not to init; if it
cannot, it logs an error at startup), so that stays refused while the relay runs. That includes a
daemon a command or browser terminal started, such as a tmux server, and everything it starts later:
a new pane of that tmux cannot raise trust. Prefer the service (`wsmp service install`): when a relay you
started by hand stops, those processes re-parent away from it and are no longer caught, while the
service's cgroup still holds them. On macOS only the relay's descendants are refused (the `ps` parent
walk), so a detached process escapes. If you do not trust the code on this account, Relay only does
not make it safe.

Lowering only stops new agent access through wsmp. It does not undo or contain software an agent
already left on the node while it had Full control, such as a systemd user service: that software
runs as the same user and can even raise trust again locally. If you distrust what an agent did,
reinstall the node.

## Secrets

Runtimes often need tokens. Node secrets are named `WSMP_SECRET_` followed by
1 to 64 of `A-Z`, `0-9` and `_`. Values stay on this node; the server only ever sees names.

```sh
wsmp secret set WSMP_SECRET_HF_TOKEN   # the value is typed at a hidden prompt
wsmp secret list                       # names and when they were set, never values
wsmp secret remove WSMP_SECRET_HF_TOKEN
```

`wsmp secret` works at either trust level (it is how a Relay-only node gets secrets) and, like
`wsmp trust full`, only from a person's terminal. At Full control the server can also set them.
A runtime names the secrets its commands receive in `launch.secrets`; an always-on runtime's
address can use one for its auth header.

## Commands and runtimes

The server asks a node to do two different kinds of work:

- **Runtimes** are definitions the server stores and versions: an always-on inference server
  already running here, or a startable one (or a service) with start, readiness and health
  commands, and a stop command where it needs one (a `process` runtime may leave it out: the
  node's stop ends everything in that part's systemd slice and proves it). The server sends the
  definitions to the node, then starts and stops instances by
  version; the node renders each command from the definition it holds, so a start never runs
  text it was not given in a definition. At Relay only, the held definitions are frozen and can
  still be started and stopped.
- **Commands** are one-off shell commands a person or an agent runs here through the server
  (inspect a GPU, pull a model). They need Full control, run as your user, are recorded in the
  node's activity, and stop when trust is lowered. An agent can also queue a command for you
  (one that needs a password, for example); it runs only when you choose Run on the Terminals
  page.

To see what this node holds and runs, read from its own files (the frozen copy at Relay only;
both commands are read only and work at either trust level):

```sh
wsmp runtime list              # runtimes, and instances with phase, ports, units and stop proof
wsmp runtime test <target>     # one small request: status and latency
```

`wsmp runtime test` takes a runtime slug, an instance handle (`i-...`) or an instance id. It asks
a running instance's readiness route (else its model list, or a TCP connect for a service without
readiness) and an always-on runtime's model list, and exits non-zero when the answer is not the
expected one (3 when nothing matches). The stop proof `wsmp runtime list` shows for a stopping or
stopped part of an instance is the one the inventory reports: `proven`, or why not (`port_in_use`,
`process_alive`, `status_unknown`, ...). To check the ports it binds each one for an instant, as
the relay does; it writes nothing and runs no definition command. Runtimes are defined in the web app or through MCP.

## Other commands

| Command | What it does |
| ------- | ------------ |
| `wsmp config path\|init\|show` | Where the config lives, create it, print it. |
| `wsmp config set-server <url> [--public-origin <origin>]` | Point at another server address (restart to apply). |
| `wsmp config set-slug <name>` | Change the saved node name. |
| `wsmp config set-file-roots <dir>...` / `clear-file-roots` | Folders the file tools may use (default: your home directory). |
| `wsmp config set-file-tools on\|off` | Turn the node file tools on or off (on by default). |
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
| 4 | the relay has no usable credential (none saved, rejected with HTTP 401, or refused at hello as revoked or enrolled with another identity); run `wsmp login`. Only under the systemd unit and in an interactive terminal; elsewhere the relay retries instead. The systemd unit does not restart on this code. |
| 5 | the server refused this wsmp's relay protocol (HTTP 426 or an `upgrade_cli`/`upgrade_server` refusal at hello). Re-run the server's `install.sh` to install the matching wsmp (or upgrade the server), then restart wsmp. Only under a systemd unit written by this version's `wsmp service install` (it does not restart on this code) and in an interactive terminal; elsewhere, including an older unit, the relay logs it and retries every 5 minutes (re-run `wsmp service install` to update an older unit). |
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
