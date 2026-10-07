# WS Model Proxy 0.4.0: upgrade notes

0.4.0 is a redesign, not an incremental upgrade from 0.3. The data model, the
web app, the relay protocol and the CLI's commands change together, and none of
them is backwards compatible. Plan it as a new installation: a new database,
every node logged in again, and every API key, agent token and pool created
again.

Rename this file to the version when the release is cut, and paste the sections
below into the GitHub release body.

## Before you deploy: a fresh database is required

There is no migration from 0.3. The 0.4.0 schema is a new baseline, and the
server, the schema hardening and the relay all assume it. Do not point 0.4.0 at
a 0.3 database, and do not use `APPLY_SCHEMA=dangerous` to force the new schema
onto an old one: that drops data and still leaves you with an unsupported
database.

To deploy:

1. Back up the 0.3 database if you want to keep its history. Nothing in it is
   read by 0.4.0.
2. Create a new, empty Postgres database and point `DATABASE_URL` at it.
3. Update the environment (see [Configuration](#configuration)): remove every
   `RATE_LIMIT_*` variable; set `ADMIN_EMAIL` when public sign-up is off (it is
   required to bootstrap the first admin on a fresh production database); leave
   `WMP_CLI_SOURCE_REV` unset so nodes install the release binary (see below).
4. Start the container once with `APPLY_SCHEMA=safe`. On an empty database
   `safe` creates every table and installs the schema hardening (triggers and
   CHECKs); nothing destructive is involved.
5. Set `APPLY_SCHEMA=off` again for normal restarts.
6. Sign in, then add your nodes, providers, pools, API keys and agent tokens
   again. Callers need their new API keys.

## Removed and renamed concepts

The 0.3 nouns are gone from the web app, MCP, the CLI and the docs. There are no
redirects from the old routes (`/dashboard/**`, `/device`, `/admin/devices`,
`/settings/mcp`).

| 0.3 | 0.4.0 |
|---|---|
| CLI, device, machine | **Node**: a machine running `wsmp`, logged in to this server. |
| Per-node feature switches (`set-deployments`, `set-mcp-commands`, `set-file-read`, `set-deployment-operator-terminal`, remote metric sources and engine adapters), MCP command modes, "Ask first"/supervised | **Trust**: one level per node, Full control or Relay only (below). |
| Endpoint, recipe, recipe revision, template, variant, deployment | **Runtime**: one inference server definition, either always-on (an address on a node) or startable (commands that start it on one or more nodes). Every edit is a new **version**. Built-in starting points are **presets**. |
| Deployment instance, capacity | **Instance**: a running copy of a runtime on a node or a group of nodes. |
| Deployment plan, layout, switch | **Profile**: a named set of runtime versions on a set of nodes; **Apply** is the one-click switch, with a preview you confirm. |
| Pool grant, inference contribution (offer/accept) | **Share**: a person may *use* your pool, *contribute* their own runtimes to it, or both. |
| Frozen peer sets for multi-node runs | **Fabric**: a named set of nodes with the IP each uses to reach the others; multi-node instances run inside one fabric. |
| Model API token / MCP token | **API key** (callers, pools only) and **agent token** (MCP, Read-only or Full). |
| Device login (`/device`) | Enrollment codes (below). |

**Pools** stay the thing clients call (`owner/pool`, `owner/pool:external`);
their members are now served models of runtimes. The public API serves pools
only.

## Nodes: logging in with an enrollment code

Device login is gone. To add a node, create an enrollment code on the
**Nodes** page and run the one-liner it shows. Written with the full path, so
it works before `~/.cargo/bin` is on your `PATH` (on a node with `CARGO_HOME`
set, run `$CARGO_HOME/bin/wsmp login` instead; the installer prints the path):

```sh
curl -fsSL https://wsmp.example.com/install.sh | sh && ~/.cargo/bin/wsmp login https://wsmp.example.com --code wsmp_enr_...
```

- `/install.sh` installs the `wsmp` 0.4.0 release binary for the node:
  Linux x86_64 or ARM64 (glibc 2.34 or newer: Ubuntu 22.04 and later, DGX OS)
  and macOS (Apple silicon or Intel). It downloads `wsmp-<target>.tar.xz` and
  `sha256.sum` from the GitHub Release and installs only when the SHA-256
  matches; a missing checksum, a mismatch or a failed download stops the
  install. No Rust toolchain is needed. The binary lands in `~/.cargo/bin`
  (`$CARGO_HOME/bin` when that is set).
- Other machines (musl, older glibc, other architectures) build the `v0.4.0`
  tag from source with `cargo install`; they need Rust 1.88 or newer and a C
  toolchain (`cc`, for example `build-essential`).
- `WMP_CLI_RELEASE_BASE_URL` points `/install.sh` at another copy of the
  release assets (an internal mirror, https only). Unset, it is this
  version's GitHub Release.
- `WMP_CLI_SOURCE_REV` makes every node build that exact commit from source
  instead (a full 40-character hash), whatever `WMP_CLI_RELEASE_BASE_URL`
  says. Use it only for a build that has no release; it no longer needs to
  be set for 0.4.0.
- Each archive and `sha256.sum` carries a signed build-provenance attestation:
  `gh attestation verify wsmp-x86_64-unknown-linux-gnu.tar.xz --repo FlyCockpit/ws-model-proxy`.
- Remove a Homebrew 0.3 `wsmp` (`brew uninstall wsmp`) if one is installed:
  it can shadow `~/.cargo/bin/wsmp` on your `PATH` (the installer warns).
- `wsmp login <url>` takes the code from `--code`, a prompt, or
  `WSMP_ENROLL_CODE`. It asks for the node's trust level and offers to
  install the per-user service.
- Codes expire after 1 hour by default (at most 7 days), can be revoked, and
  can be used by up to 50 nodes. A multi-use code can add labels to every node
  it enrolls.
- **Replace codes** move an existing node to a new machine: same node, runtimes
  and traffic, new identity and credential; the old machine's credential stops
  working. `wsmp login` names the node it replaces and asks you to confirm
  (`--replace` to skip the prompt). A Relay-only node stays Relay only after a
  Replace. A plain code never takes over an existing node name
  (`slug_taken`).
- **Temporary nodes**: a code can mark the nodes it enrolls as temporary. The
  server deletes such a node once it has been offline for the code's window
  (1 hour unless set), and `wsmp login` says so.
- Node names are 3 to 63 characters (lowercase letters, digits, single
  hyphens); a few route names are reserved.

Full details: [`apps/cli/README.md`](../../apps/cli/README.md).

## Relay protocol 3.0: upgrade every wsmp

A 0.3 node cannot reach a 0.4.0 server at all: its credential does not exist in
the new database, so it is refused at authentication. Every node needs the new
`wsmp` and a new `wsmp login` with an enrollment code.

The server accepts only relay protocol 3.0, and a 0.4.0 `wsmp` connects only to
a server that speaks it. A node that is enrolled but runs an older `wsmp` is
refused at hello with "This server requires relay protocol 3.0. Upgrade wsmp
and restart it.", and the web app says "Upgrade wsmp on the node first."

**Replace the old service unit.** A 0.3.1 service runs `wsmp daemon start
--foreground`, which no longer exists. Accept the service offer at
`wsmp login`, or run `wsmp service install`, to rewrite it. If you log in with
`--no-service`, run `wsmp service uninstall` first so the old unit stops
restarting.

Removed CLI commands: `connect`, `daemon *`, `token`, `endpoints *`, `reload`
and the `config set-*` capability switches. Use `wsmp run`, `wsmp service` and
`wsmp trust`; runtimes are defined in the web app or through MCP, not with the
CLI.

## Trust: Full control and Relay only

Each node gives the server one of two levels, chosen at `wsmp login` and kept
in the node's own configuration:

- **Full control** (default): the server may define and start runtimes, run
  commands, read and write files inside the folders you allow, open terminals
  and set node secrets.
- **Relay only**: the server may only send requests to the model servers on the
  node and start or stop the runtimes it already holds. Definitions are frozen
  when trust is lowered; nothing new can be defined, run or read, and running
  node commands are stopped. People can still start and stop those runtimes
  from the browser; agents cannot.

Lowering works from the browser or with `wsmp trust relay` and sticks on the
node. Only `wsmp trust full`, typed at the node's terminal, raises it; no frame
from the server can. Lowering protects against a *future* compromise: commands
written while the node was Full control (frozen start commands, node metric
commands) keep running, which is why the Lower dialog lists them.

## Browser terminals and interactive steps

**Browser terminals** open a shell on a node from the **Terminals** page. They
need Full control and the node's own opt-in. At Full control, `wsmp login` asks
for it next to the trust question (default yes). Without a terminal, pass
`--human-terminal on|off`; otherwise the saved setting stays (off unless set)
and login says so. Change it later with `wsmp config set-human-terminal
on|off`; the server cannot. Limits are configurable and higher by default: 8 open per
user and 4 per node. The server settings are `WMP_TERMINAL_USER_LIMIT` and
`WMP_TERMINAL_CLI_LIMIT` (each 1 to 64), and each node caps its own with `wsmp config set-max-terminals` (1 to
32, default 4). The lowest limit applies; operator terminals are not counted.

**Interactive steps** are runtime commands a person must run, typically one
that asks for a sudo password. A startable runtime marks them `interactive`;
such a command needs a `status` command, and an interactive start needs
`management: service`. When one is due, the instance shows **Needs you** and
the node opens an operator terminal, which you open from the Terminals page or
the runtime. It shows the exact command and who wrote it, and runs it only
after you press Enter. The node then:

- runs only that command on a fresh PTY (under `/bin/sh -c`), never an
  interactive shell or prompt: when it exits the terminal ends, with nothing
  left to type into;
- runs `sudo -k` before and after it, and strips `SUDO_ASKPASS`, so no sudo
  credential survives between steps;
- forwards your keystrokes only while the command runs.

Operator terminals work at both trust levels (at Relay only, for frozen
definitions) and need no setting on the node. Agents can write runtimes with
interactive steps but can never answer, reopen or cancel them. A sudoers
`NOPASSWD` rule for the exact command remains the fully automatic alternative.

### Threat model: passwords typed into a terminal

A sudo password you type into a browser terminal or an operator terminal passes
through the server, in encrypted form. What holds today:

- **Keystrokes are encrypted between your browser and the node.** Each viewer
  agrees a key with the node (P-256 ECDH, then HKDF), and every input and
  output frame is sealed with AES-GCM as a `term.sealed` frame; the server
  accepts only sealed frames from the browser and forwards their bytes
  unchanged.
- **The server never stores or logs terminal bytes.** The node's activity
  records terminal events (a terminal opened; an interactive step's outcome
  and exit code), never what was typed or shown.
- **Your browser pins each node's identity key** the first time it opens a
  terminal there and checks the node's signature over its terminal key on
  every open, so a server that later substitutes the key is shown as "identity
  changed". `wsmp terminal fingerprint` prints the value to compare.

What does not hold:

- **A compromised server can capture the password anyway.** It serves the web
  page that encrypts your keystrokes, so it can serve a modified page that
  reads them before encryption.
- **A compromised server can type into the running command.** Unless the node
  requires approval of each browser identity (`wsmp config
  set-terminal-approval on`, off by default), the node accepts any browser key
  the server relays, so the server can join an operator terminal itself, press
  Enter on its confirm screen, and send input while the command runs.
  Approval stops a key the server makes up; it does not stop a modified page
  running in a browser you already approved.
- **The server sees the size and timing of every frame.** Each keystroke is
  its own sealed frame, so a password's length and typing rhythm are visible
  to the server even though the characters are not.
- On a browser's first use of a node there is no earlier pin to compare with;
  check the fingerprint if it matters.

If that is not acceptable for a machine, do not type its sudo password into a
web terminal: give the exact command a `NOPASSWD` sudoers rule instead, and use
Full control only where trusting the server with a shell is fine.

## Stops that can't be confirmed

A stopping instance keeps its port and GPUs until its node proves the process
is gone. When the stop command fails, the server asks the node to check (no
process of the runtime left, `status` says stopped, port free) and finishes
the stop on its own when the check passes. If it can't confirm the stop (the
process still runs, or the node has been offline for 10 minutes), the instance
shows **Stop not confirmed**. The check repeats every 5 minutes.

After checking on the node that the process is really gone, press **Mark as
stopped…** on the runtime or node page. The dialog shows when the stop was
requested, the last automatic check and the node's connection. Marking touches
nothing on the node: the instance settles stopped, while its port and GPUs
stay counted until a later check proves the process gone or you restart the
instance. Full agents can do the same on Full-control nodes with
`runtime_stop {markStopped: true, confirm: "MARK_STOPPED"}`. Each mark writes
a "marked as stopped" row in the node's activity.

## Configuration

### Rate limits

The `RATE_LIMIT_*` settings are gone and no longer read (the server warns at
startup when one is still set). Every limit uses its built-in budget, and one
setting, `WMP_RATE_LIMIT_SCALE` (default 1, 0.1-100), multiplies every budget;
windows and block durations stay fixed. The per-recipient email caps and the
failed-password cap are always on (on unreleased master builds, setting their
points to 0 turned them off; that is gone).

### Email recipient caps

The anonymous endpoints that send mail to an address in the request body
(resend verification, request password reset) allow 3 mails per address per hour;
sign-up has its own cap of 6 per address per hour. Both are always on, with or
without SMTP configured, and `WMP_RATE_LIMIT_SCALE` can raise them but never
below 1. The enrollment-code exchange is new: 10 attempts per IP per 15
minutes, where only failures use up the budget (a successful exchange is
refunded), and 20 exchanges per code owner per hour, successes included.

### Other environment changes

- **Added:** `WMP_RATE_LIMIT_SCALE`, `WMP_CLI_RELEASE_BASE_URL` (where
  `/install.sh` downloads the CLI), `WMP_CLI_SOURCE_REV` (a commit
  `/install.sh` builds instead), `WMP_TERMINAL_USER_LIMIT`, `WMP_TERMINAL_CLI_LIMIT`,
  `WMP_MCP_ENABLED` (MCP kill switch, on by default), `WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY`
  (was `WMP_MCP_PAT_ALLOW_NO_EXPIRY` on unreleased master builds), `ADMIN_EMAIL`,
  `RELAY_REQUEST_RETENTION_DAYS`.
- **Removed:** every `RATE_LIMIT_*` variable, `MODEL_API_ANTHROPIC_ENABLED`,
  `MODEL_API_GLOBAL_CAPACITY_ENABLED`, `MODEL_API_PROTOCOL_ADAPTATION_ENABLED`.

Run `pnpm env:check` against your deployment's variable list, or compare it
with the regenerated `.env.example`.
