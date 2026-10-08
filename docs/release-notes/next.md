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
| CLI, device, machine | **Node**: a computer running `wsmp`, logged in to this server. |
| Per-node capability switches (`set-deployments`, `set-mcp-commands`, `set-file-read`, `set-deployment-operator-terminal`, remote metric sources and engine adapters), MCP command modes, "Ask first"/supervised | **Trust**: one level per node, Full control or Relay only (below). The node's other `wsmp config` settings stay (file roots, file tools, browser terminals, runtime hosts; see [Relay protocol 3.0](#relay-protocol-30-upgrade-every-wsmp)). |
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
- Other systems (musl, older glibc, other architectures) build the `v0.4.0`
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
- **Replace codes** move an existing node to a new computer: same node, runtimes
  and traffic, new identity and credential; the old computer's credential stops
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

Removed CLI commands: `connect`, `daemon *`, `token`, `endpoints *`, `reload`,
`service env-sync` and `service env-path` (the service needs no environment
file: the node credential and node secrets are files the relay reads; re-run
`wsmp service install` and delete an old `service.env`), and the
capability switches `config set-mcp-commands`, `set-file-read`,
`set-remote-metric-sources`, `set-remote-engine-adapters`, `set-deployments`
and `set-deployment-operator-terminal`. Use `wsmp run`, `wsmp service` and
`wsmp trust`; runtimes are defined in the web app or through MCP, not with the
CLI. A 0.3 `config.json` `endpoints` list is ignored and dropped on the next
write. The rest of `wsmp config` stays: `path`, `init` and `show`, and the
setters `set-server`, `set-slug`, `set-runtime-hosts`, `set-file-roots` /
`clear-file-roots`, `set-file-tools`, `set-file-tools-as-root`,
`set-human-terminal`, `set-terminal-approval` and `set-max-terminals` (see
`wsmp config --help` and [apps/cli/README.md](../../apps/cli/README.md)).

New on the node: `wsmp runtime list` (the runtimes and instances the node
holds, with phase, ports, units and stop proof) and `wsmp runtime test
<slug|handle>` (one small request: status and latency), both read only and
available at Relay only too; `wsmp status` lists the same runtimes and
instances. `wsmp service restart` and `wsmp service logs [-f] [-n N]` manage
the service, and `wsmp login --yes` takes the defaults without asking (it
still needs `--trust`, and never turns browser terminals on). Hardware is
declared on the node's page in the web app or through MCP; `wsmp hardware`
only shows what the node detects.

**Request bodies are sent with a Content-Length.** A node relays every request
body with its exact length instead of chunked framing, so strict
OpenAI-compatible servers (TensorFold, gufo and similar) no longer answer 400.
When a runtime does answer with an error, the request log and MCP
(`requests_list`, `model_test`) show one redacted line of what it said.

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

Lowering only stops new agent access through wsmp. It does not undo or contain
software an agent already left on the node while it had Full control, such as a
systemd user service: that software runs as the same user and can even raise
trust again locally. If you distrust what an agent did, reinstall the node.

## Sharing pools and runtime definitions

Share a pool or a runtime definition from **Access → Shares** by e-mail. The
person gets it at once only when their account's e-mail address was verified
through the verification e-mail (which needs SMTP). Anyone else, including an
address with no account yet, gets an invite link instead: e-mailed when SMTP is
configured, otherwise shown to you once to pass on. The link works for 14 days
and is accepted by signing up or signing in through it, whatever address that
account uses. An address with an unverified account and one with no account
get the same answer (a direct share does show that the address belongs to an
account with a verified e-mail). Pending invites are listed on the same page,
where you can resend (a new link; the old one stops working) or withdraw them.
Deleting a runtime removes its invites.

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

If that is not acceptable for a node, do not type its sudo password into a
web terminal: give the exact command a `NOPASSWD` sudoers rule instead, and use
Full control only where trusting the server with a shell is fine.

## File tools default to the home directory

On a Full control node, agents' file tools now work out of the box: with no
roots configured they use the home directory of the user wsmp runs as (`nodes_get`
shows `features.files.source`: `default`, `configured` or `disabled`). wsmp's own
files stay protected by the node's deny-list. `wsmp config clear-file-roots`
returns to this default; it no longer turns the file tools off. To keep agents
out of files, run `wsmp config set-file-tools off` (or lower the node to Relay
only).

## Pools translate between API protocols by default

A pool now answers OpenAI Chat Completions, OpenAI Responses and Anthropic
Messages callers even when a member serves only one of them: **API adaptation**
(pool Advanced) is on by default. A member that serves the caller's protocol
natively is always tried first; translation is used only when no native member
can take the request. Translation is strict: a request feature it cannot carry
over (for example `logprobs`, audio output or a vendor-specific field) is
refused with a 400 that names the feature, never silently dropped. Merging a
developer message into the system prompt for Anthropic targets stays off unless
you turn on **lossy developer-role collapse**. Turn API adaptation off on a pool
to serve only native requests.

## Request compatibility: any engine, any harness

Pools now adapt each request to the engine that serves it, so vLLM, SGLang,
llama.cpp, Ollama, LM Studio and other OpenAI- or Anthropic-style servers work
with the clients you already use, including harnesses you cannot change:

- **Unknown fields**: per runtime, `auto` (default) drops fields the engine does
  not accept, `forward` sends everything, `strict` refuses them. What an engine
  accepts is read from its OpenAPI description when an instance becomes ready
  (through the node, loopback only) and otherwise learned from its 400s: the
  named field is dropped and the request retried once, before anything reached
  the client. Semantic fields (messages, tools, sampling, output constraints,
  reasoning, ...) are never dropped silently: the caller gets a 400 naming the
  field.
- **Rewrite rules** per runtime version (rename, drop, default, clamp, role
  mapping such as developer to system), header modes (forward or strip
  `anthropic-beta`, `OpenAI-Beta`, ...) and response shaping (reasoning field,
  strict-SDK cleanup). Agents can edit them; every edit is a version.
- **Model-name aliases**: map `gpt-4o` or `claude-sonnet-4-5` to one of your
  pools, for all keys or one key. `/v1/models` lists them.
- **Auth styles**: the model API accepts `Authorization: Bearer`, `x-api-key`
  and `api-key`.
- Requests show what was dropped or rewritten, and usage an engine did not
  report is estimated and marked.

The schema gains `runtime_version.compat`, `runtime_request_profile`,
`model_alias`, `relay_request.compat` and `relay_request.usageEstimated`:
redeploy with `APPLY_SCHEMA=safe` once. Nodes need the new `wsmp` to let the
server read engine descriptions; older nodes keep working and learn from 400s
only.

## Stops that can't be confirmed

A stopping instance keeps its port, memory and GPUs until its node proves the
process is gone. When the stop command fails, the server asks the node to
check (no process of the runtime left, `status` says stopped, port free) and
finishes the stop on its own when the check passes. If it can't confirm the
stop (the process still runs, or the node has been offline for 10 minutes),
the instance shows **Stop not confirmed**. While the node is online, the check
repeats every 5 minutes.

After checking on the node that the process is really gone, press **Mark as
stopped…** on the runtime or node page. The dialog shows when the stop was
requested, the last automatic check and the node's connection. Marking runs
nothing on the node: the instance settles stopped, while its port, memory and
GPUs stay counted until a later check proves the process gone or the instance
starts again (an instance that should keep running is restarted). Full agents
can do the same on Full-control nodes with
`runtime_stop {markStopped: true, confirm: "MARK_STOPPED"}`. Each mark writes
a "marked as stopped" row in the node's activity.

## Runtime starts and health

- A `management: "process"` runtime no longer needs a stop command: the node's
  stop ends everything in the rank's slice and proves it. The vLLM, SGLang and
  llama.cpp presets drop their `stop: "true"` stub. Service runtimes still
  need `stop` and `status`.
- A `process` start that hands its server off (`docker compose up -d`, a
  server that daemonizes) now fails with **process_detached** instead of
  looking healthy while the node can neither watch nor stop it. Define such a
  runtime as `management: "service"` with real stop and status commands.
- An unhealthy instance shows why its last health check failed (for example
  "answered HTTP 503" or "the serving process is not running in its unit") on
  the runtime page and as `healthDetail` in `runtimes_get`.
- A wsmp the server refuses for its relay protocol no longer restarts every 5
  seconds: under a service unit written by `wsmp service install` it stops
  with exit code 5, and under an older unit it retries every 5 minutes. Re-run
  the server's install.sh, then `wsmp service install` to update the unit.

## Configuration

### Rate limits

The `RATE_LIMIT_*` settings are gone and no longer read (the server warns at
startup when one is still set). Every limit uses its built-in budget, and one
setting, `WMP_RATE_LIMIT_SCALE` (default 1, 0.1-100), multiplies every budget;
windows and block durations stay fixed. The per-recipient email caps and the
failed-password cap are always on (on unreleased master builds, setting their
points to 0 turned them off; that is gone).

Relay connections (`/api/cli/ws`) have their own limits and no longer share
the sign-in bucket, so a node reconnecting in a loop cannot lock its owner out
of sign-in from the same address. Each node may open 10 relay connections per
minute (then it waits 5 minutes), and each address may fail 30 relay
connections per minute before authenticating (then 5 minutes); only failed
connections count against an address, so many nodes behind one NAT can
connect at once. A refused connection
answers 429 with `Retry-After`, and `wsmp` waits at least that long.

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

Run `pnpm env:check` against your server's variable list, or compare it
with the regenerated `.env.example`.
