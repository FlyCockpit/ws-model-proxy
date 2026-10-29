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

> The node client for WS Model Proxy 0.4.2.

`wsmp` turns a computer into a **node** of your WS Model Proxy server. It keeps one outbound
websocket to the server (no port forwarding), relays model requests to the runtimes on this
node, and, when you allow it, runs the runtimes, commands, file operations and terminals the
server asks for.

0.4.2 speaks relay protocol 3.0 and remains compatible with 0.4.0 and 0.4.1 servers and CLIs.
Image paste requires both the web app and the node's CLI to be upgraded to 0.4.1.
A 0.3 CLI cannot connect to a 0.4.x server, and this CLI cannot connect to a 0.3 server.

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

`WMP_CLI_RELEASE_BASE_URL` points the script at a mirror of the release assets. To check a
downloaded archive yourself:

```sh
gh attestation verify wsmp-aarch64-unknown-linux-gnu.tar.xz --repo FlyCockpit/ws-model-proxy
```

Or build a release tag with cargo directly:

```sh
cargo install --git https://github.com/FlyCockpit/ws-model-proxy --tag v0.4.2 --locked wsmp
```

**Windows.** In PowerShell (Windows PowerShell 5.1 or PowerShell 7), from your server:

```powershell
irm https://wsmp.example.com/install.ps1 | iex
```

It installs the server's version like `install.sh` does: the release's
`wsmp-x86_64-pc-windows-msvc.zip`, checked against `sha256.sum` (it refuses to install on a
mismatch or a missing checksum), into `%USERPROFILE%\.cargo\bin` (`%CARGO_HOME%\bin` when set),
else a source build with cargo. Windows 11 on ARM64 runs the x86_64 binary. The Nodes page's
**Add a node** has a Windows tab with this command and the login after it. Windows 11 on x86_64
is supported. See [Windows](#windows) for what runs there and what does not.

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

**Windows.** The service is a Task Scheduler task of yours, `wsmp-relay-<username>`. It starts
when you log on, runs as you with no extra privileges and no console window, and stops when you
log off. It needs no password and no administrator rights. A relay that exits is started again
within 5 minutes while you are logged on. A task cannot set environment variables, so the task
passes the config and state paths to `wsmp run` itself. It also passes a log file,
`%LOCALAPPDATA%\ws-model-proxy\logs\relay.log`, which rolls over at 10 MiB and keeps 4 older files.
`wsmp service logs` reads that file. Node state is in `%LOCALAPPDATA%\ws-model-proxy` on Windows.

**Windows terminals.** Browser terminals run on a Windows pseudoconsole (ConPTY, Windows 10 1809 or
later), at Full control only. The browser picks the shell: PowerShell 7 (`pwsh`), Windows
PowerShell, Command Prompt, or a WSL distribution, defaulting to the node's choice, which is pwsh,
then Windows PowerShell, then Command Prompt (`wsmp config set-terminal-shell <id>` changes it). The
shells are found when the relay starts. Each terminal runs in a job of its own, so closing it ends
everything its shell started. A pasted image's path is quoted for the terminal's shell
(PowerShell, Command Prompt, or `/mnt/c/...` in WSL).

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
install|uninstall|restart`, `wsmp logout`, `wsmp terminal approve`, `wsmp recover --apply` and
`wsmp update`.
`wsmp run` checks only `WSMP_JOB`, since the relay's own service starts it. Reading (`wsmp config
show|path`, `wsmp service status|logs`, `wsmp runtime list|test`, listings) and lowering (`wsmp trust relay`, `wsmp
terminal approvals revoke`) work from anywhere.

This is a **best-effort guard against agents** raising or widening their own access through the
server: dropping `WSMP_JOB`, `systemd-run --user` or a crontab does not get past it. It is **not a
security boundary against other code running as your user**: such code can move itself into a
cgroup named like a terminal's, ask your tmux to run a command, `ssh` back in to this node, or
simply edit your files, including this CLI's configuration. On Linux the relay adopts what its
commands leave behind (a `setsid` or double-forked process re-parents to it, not to init; if it
cannot, it logs an error at startup), so that stays refused while the relay runs. That includes a
daemon a command or browser terminal started, such as a tmux server, and everything it starts later:
a new pane of that tmux cannot raise trust. Prefer the service (`wsmp service install`): when a relay you
started by hand stops, those processes re-parent away from it and are no longer caught, while the
service's cgroup still holds them. On macOS only the relay's descendants are refused (the `ps` parent
walk), so a detached process escapes. If you do not trust the code on this account, Relay only does
not make it safe.

On Windows there is no `/proc` to walk. The relay puts itself in a job object when it starts, so
everything it starts, and everything those start, is a member, and a running relay answers
whether a caller is one of its own. Runtimes run in jobs of their own that outlive the relay, so
their members are refused whether or not a relay runs. What Windows does not cover: a member can
ask a process outside wsmp's jobs to start something for it (Task Scheduler, WMI, Explorer), and
that is then not a member. This is why browser terminals on Windows need Full control.

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
  node's stop ends everything in that part's systemd slice, or its runtime hosts' jobs on
  Windows, and proves it). The server sends the
  definitions to the node, then starts and stops instances by
  version; the node renders each command from the definition it holds, so a start never runs
  text it was not given in a definition. At Relay only, the held definitions are frozen and can
  still be started and stopped.
- **Commands** are one-off shell commands a person or an agent runs here through the server
  (inspect a GPU, pull a model). They need Full control, run as your user, are recorded in the
  node's activity, and stop when trust is lowered. An agent can also queue a command for you
  (one that needs a password, for example); it runs only when you choose Run on the Terminals
  page.

Every runtime command gets, on top of a scrubbed environment, the secrets its definition names,
the GPUs placement gave its rank (`CUDA_VISIBLE_DEVICES` and `HIP_VISIBLE_DEVICES`, with
`CUDA_DEVICE_ORDER=PCI_BUS_ID`) and, for a single-node runtime with reservations, the worker
nodes they were assigned to: `WSMP_RESERVATION_COUNT`, then per reservation
`WSMP_RESERVATION_<index>_NODE` (the node's slug), `WSMP_RESERVATION_<index>_NODE_ID` and, when
placement gave it GPUs on that worker, `WSMP_RESERVATION_<index>_GPUS` (their indices, in the
`CUDA_VISIBLE_DEVICES` format the rank's own GPUs use, e.g. `0,3`). A stop
or status check sees the reservations of the launch it checks. These are environment variables,
not placeholders, so they do not change the definition's launch hash.

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
`process_alive`, `port_held_outside_runtime`, `status_unknown`, ...). `port_held_outside_runtime`
means the port is held while nothing is left in the rank's units, usually because what holds it
escaped them (containers from `docker compose up -d`, a daemon that re-parents). For a `service`
runtime the inventory runs no status command and checks no unit first, so it names a held port
`port_in_use`. To check the ports it binds each one for an instant, as
the relay does; it writes nothing and runs no definition command. Runtimes are defined in the web app or through MCP.

**Shells.** A runtime's text commands run in the shell its launch names (`launch.shell`: `sh`, the
default, or `pwsh`, `powershell` or `cmd`). An argv command
(`["llama-server", "-m", "{{model}}", "--port", "{{port}}"]`) runs on every node, which quotes it
for its own shell (`cmd` cannot take one). The server places a launch only on nodes whose
management mode and shells can run it. It does not match the node's operating system: a launch
whose `sh` commands only Linux can run (`systemctl`) may still be placed on macOS.

**Windows runtimes.**
- A launch (prepare, start, after-join) runs in a runtime host (`wsmp __runtime-host`) with a hidden
  console. Everything its command starts stays in the host's job.
- The runtime keeps running while the relay restarts.
- A stop sends Ctrl+Break to the command, then ends the whole job after 10 seconds (at most half
  the step's time).
- Status, stop and health commands run to completion in a job of their own.
- An argv command whose program is an `.exe` on the command's `PATH` (or an absolute path to
  one) starts directly, without a shell: it gets every argument exactly, and its exit status is the
  command's. Any other program (a `.cmd` or `.bat` shim such as `npx`, a PowerShell command) runs
  through the shell.
- PowerShell commands exit with their last command's status, as `sh` does, so a status command
  says stopped by exiting 3. A program that cannot be found fails the command (exit 1).
- An interactive step (one that needs its person: a prompt to answer, a sign-in to finish) opens
  an operator terminal as on Linux. Enter runs the step's script in its shell on a pseudoconsole,
  inside a job that ends with the relay. There is no `sudo -k` around it: Windows caches no sudo
  credential.

## Windows

`wsmp` runs natively on Windows 11 (x86_64). Windows 10 1809 or later may work, but it is not
supported.

**What runs.**
- the relay and `wsmp service` (a Task Scheduler task);
- trust and the local control commands;
- browser terminals (ConPTY, with PowerShell 7, Windows PowerShell, Command Prompt or a WSL
  distribution);
- node commands: in PowerShell by default (`pwsh`, else Windows PowerShell), in `cmd` when asked,
  or as an argv;
- runtimes in PowerShell or `cmd`, including interactive steps;
- the file tools: read, stat, list, search, write, edit, rename, mkdir and delete.

Install PowerShell 7 (`pwsh`) for runtimes and node commands, with its MSI or
`winget install Microsoft.PowerShell`. `wsmp` does not use the Microsoft Store build: Windows
starts a Store app in a job of its own, outside the job `wsmp` ends a command, runtime or
terminal with, so what it started would keep running. Programs from the Store that a command
names itself (Store Python, `winget`) run outside that job too: cancelling or timing out the
command does not end them. Windows PowerShell 5.1 works, but it changes some
arguments it passes to a program (an empty one, or one with a quote in it). An argv whose program
is an `.exe` does not go through it; one that would (a `.cmd` shim, say) fails with such an
argument there.

**File tools on Windows.**
- **Paths** are written and shown in a POSIX view: `C:\Users\ada\notes.txt` is
  `/c/Users/ada/notes.txt`, with the drive letter in lower case. The node advertises its file
  roots in the same form.
- **Refused names:** anything that could reach a different object than it spells. That covers
  `.` and `..`, `\`, `:` (alternate data streams), wildcards, trailing dots or spaces, and device
  names such as `NUL`.
- **Links and junctions** are resolved by Windows, and the policy is checked against the file
  actually opened. So a link out of the file roots, or to a protected file, is refused, and list
  and search never walk into one.
- **Elevated `wsmp`** counts as running as root (see `set-file-tools-as-root`).
- **Writes** replace a file atomically: the new content goes to a staging file beside it
  (`.<name>.wsmp-<random>`), the etag is checked again, and the staging file is renamed over the
  target. A rename never replaces a destination it did not check. `mode` is refused (Windows has
  none).
- **Not yet as on Unix:** there is no recovery journal (`wsmp recover`). A crash during a write
  can leave a staging file behind; delete it by hand. A writer that replaces the file between the
  last check and the rename is overwritten. A replaced file takes its folder's inherited
  permissions, not an explicit ACL of its own, and loses the hidden or system attribute.

**Not on Windows (yet).**
- Engines that need Linux, such as vLLM and SGLang. llama.cpp's `llama-server`, Ollama and LM
  Studio run natively.

**Limits to know.**
- The service runs while you are logged on. At log off, Windows ends it and the runtimes it
  started.
- The trust check has the gap described under [Trust](#trust).
- A runtime host keeps the relay's own stdout and stderr open when they are pipes, as with
  `wsmp run | Tee-Object relay.log`, until the runtime stops. The service and a relay run in a
  terminal have console handles instead, so they are not affected.

**WSL2 instead.** The Linux `wsmp` in a WSL2 distribution has every Linux feature: the file
tools' recovery journal, and vLLM with CUDA on WSL.
1. Enable systemd in the distribution (`/etc/wsl.conf`: `[boot]` then `systemd=true`), then run
   `wsl --shutdown`.
2. Install `wsmp` with `install.sh` inside the distribution.
3. Run `loginctl enable-linger $USER` and `wsmp service install` as on any Linux.

Agents then see Linux, not Windows, and files under `/mnt/c` are slow. WSL can stop a distribution
that nothing is using: after you close your terminals, check that the node stays connected, and
start the distribution at log on if it does not.

## Updating

The node's owner can update a Full-control node from the Nodes page (**Update**), or run `wsmp
update` on the node. Either way wsmp installs the server's version. The server offers **Update**
only where it has been verified (Linux and WSL, and macOS; Windows when the server sets
`WMP_AGENT_UPDATE_WINDOWS`); elsewhere the Nodes page
shows the command to run on the node, and `wsmp update` there still works.

1. It downloads the release archive beside the binary (never in `/tmp`), checks its SHA-256, and
   runs the new build's `--version`, which must print the server's version. Nothing changes if any
   of that fails.
2. It keeps the current binary as `wsmp.prev`, arms a rollback job that runs `wsmp.prev` at a
   deadline (180 s by default), puts the new binary in place and restarts the relay service (exit
   code 75). The window counts from the new build's start: each time it starts unconfirmed (at
   most three times) it moves the deadline to a full window after that start, so a slow restart
   or reconnect does not roll back a good build. The rollback job is a persistent systemd user timer and service
   (`wsmp-update-deadman.{timer,service}`, beside the relay's unit) on Linux and WSL, a one-shot
   LaunchAgent (`com.flycockpit.wsmp.update-deadman`) on macOS, and a one-shot scheduled task
   (`wsmp-update-deadman-<user>`) on Windows. It survives a reboot during the trial; the new
   build then gets a full window from the boot to confirm before it is rolled back.
3. The new build confirms once it has connected, applied the server's definitions and stayed up
   for 30 s; it then removes the rollback job. A build that does not confirm is rolled back: the
   failed build is kept as `wsmp.failed`, the previous one returns, and the relay tells the server
   (with the end of the failed build's log).

- **Homebrew** installs are updated with `brew upgrade flycockpit/tap/wsmp`, with no automatic
  rollback; a pinned formula or one from another tap is refused. Recover by hand with `brew
  reinstall flycockpit/tap/wsmp && wsmp service restart`.
- **Source builds** (`cargo install --git`, or a server that pins `WMP_CLI_SOURCE_REV`) are never
  replaced; the Nodes page shows the `cargo install` command to run.
- The relay must run as its installed service (`wsmp service install`) for an update from the
  browser: something has to restart it.
- `wsmp config set-remote-updates off` refuses updates from the browser on this machine
  (`allowed` is the default); `wsmp update` here still works.
- On macOS, runtime instances may stop when the relay restarts: an update from the browser waits
  until none runs (or the owner forces it: the server stops them first, as any stop from the
  Runtimes page, and the node installs once they have stopped), and `wsmp update` needs
  `--force` while any runs. Linux and Windows instances keep running and are adopted by the new
  relay.
- wsmp updates itself only where it knows how it was installed: from `<state>/install.json`,
  which this release's `install.sh` and `install.ps1` write, or from a Homebrew `Cellar` or cargo
  path. A binary without a receipt (installed by an older script, a package or a copy) is never
  overwritten: run the install script once to allow updates.
- Where instances stop with the relay (macOS), the node checks again that it is idle after the
  download, and from that check to the restart it starts no runtime launch and no node command
  (the server sends a refused launch step again after the restart).
- `wsmp update status [--json]` shows the build, how it was installed (from
  `<state>/install.json`, or `unknown`) and the last update.

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
| `wsmp config set-terminal-shell <id>\|default` | Windows: the shell a browser terminal starts by default (`pwsh`, `powershell`, `cmd`, `wsl:<distro>`). |
| `wsmp config set-file-tools-as-root on\|off` | Allow the file tools when wsmp runs as root. |
| `wsmp config set-remote-updates allowed\|off` | Allow or refuse updates from the browser ([Updating](#updating)). |
| `wsmp update [--force]` / `wsmp update status` | Install the server's wsmp here, or show the last update ([Updating](#updating)). |
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
| 75 | the relay installed an update and exits so its service starts the new binary (systemd restarts it, launchd's `KeepAlive` does, and on Windows the update's rollback task starts the relay task again) |
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
