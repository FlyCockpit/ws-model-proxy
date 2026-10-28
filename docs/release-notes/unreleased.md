# Upgrade notes for the next release

Fold these into `docs/release-notes/X.Y.Z.md` when the release is cut
(`apps/cli/docs/releasing.md`), then delete this file.

## Every node must be upgraded

This release does not work with `wsmp` 0.4.2 or older. Upgrade the server first, then every
node. The relay protocol is now 3.1: the server refuses a 3.0 agent when it connects, with a
message to upgrade, and the agent stops instead of restarting every few seconds. The Nodes page
shows such a node as needing an upgrade. Older agents do not "remain compatible", whatever the
0.4.2 notes said about earlier releases.

Upgrade each node with the command for its platform, then restart its service:

- Linux and macOS (installed with the script): `curl -fsSL <server>/install.sh | sh`
- Windows: `irm <server>/install.ps1 | iex`
- Homebrew: `brew upgrade flycockpit/tap/wsmp`

Then run `wsmp service restart`.

Why: on 2026-10-28 a runtime definition with an argv `start` made agents built before the
Windows work exit on every connect. They could not parse it, a frame they could not parse ended
the process, and the service manager restarted it every 5 seconds until the server answered 429.
This release removes both halves of that:

- One definition a node cannot read no longer ends its session. The node refuses that
  definition (`invalid`, with the JSON path it could not read), applies the others, and stays
  online. A node part it cannot read (metric commands, fabrics, port range) is refused the same
  way, and the node keeps the one it held.
- The result of `runtime_create` and `runtime_update`, and the runtime's page, show a node that
  refused a definition as refused, with the reason and the path, instead of "pending".
- A frame the agent cannot read closes the connection and reconnects with backoff (5 s,
  doubling, up to 5 minutes) instead of exiting. Its log names the frame type and the field that
  failed. The agent exits only for a rejected credential (exit 4) or a refused protocol (exit 5),
  and the service no longer restarts it after either, on Linux, macOS and Windows.

**Windows behaviour change.** A `node_command_run` without `shell` now runs in PowerShell, not
`cmd`. Commands written for Command Prompt need `shell: "cmd"`.

Windows nodes now report their memory (total and available), so runtime launches that ask for
`cpu` or `unified` memory can be placed on them.

On a volume where names are not case-sensitive (macOS by default, a casefold ext4 directory, an
SMB share), the node file tools now treat two spellings of one name (`Notes.txt`, `notes.txt`)
as one file when they serialize changes, as they already did on Windows. A rename that changes
only the case of a name (`notes.txt` → `Notes.txt`) no longer needs `overwrite` there either: it
renames the one file in place, as on Windows.

## Windows nodes

`wsmp` now runs natively on Windows 11 (x86_64): the relay, `wsmp service` as a Task Scheduler
task, trust, browser terminals on ConPTY, node commands, and runtimes in PowerShell or `cmd`.
Install it from the server with `irm <server>/install.ps1 | iex`, or with the Windows tab of the Nodes page's Add a node. It needs this release's server, which places a
runtime only on nodes whose management modes and shells can run it (a Windows node has no `sh`,
so no `sh` launch lands there). Image paste works in
Windows terminals once the web app is upgraded too: the node quotes the path for the terminal's
shell. Interactive runtime steps open operator terminals there as on Linux. On Windows the node
file tools take paths in a POSIX view (`/c/Users/...`). Writes, edits, renames, mkdir and delete
work there too, with atomic replace but without the Unix recovery journal. The CLI README's
Windows section lists the limits, and the WSL2 alternative.

`node_command_run` can now name its shell (`shell`: `sh`, `pwsh`, `powershell` or `cmd`, one the
node reports), or take an argv (`command: ["curl", "-d", "…"]`) whose arguments reach the program
without a shell reading them; on Windows a `.cmd` shim such as `npm` gets them escaped for cmd.
Command text is at most 4096 bytes, what nodes accept. On Windows, a command without `shell` runs
in PowerShell (`pwsh`, else Windows PowerShell; never a Microsoft Store `pwsh`, which Windows runs
outside the job that ends a command, so install PowerShell 7 with its MSI or winget), never in
Git Bash's `sh`; the node lists its default first in `features.launch.shells`, and PowerShell
writes UTF-8 even in a console with the OEM code page (every command, metric command and
runtime step has a hidden console of its own, so the terminal running `wsmp run` keeps its
code page); name `shell: "cmd"`
for Command Prompt, which now gets the text exactly as sent. A node must run this release's
`wsmp` for `shell` or an argv: an older one refuses the command, and the server says to upgrade
it. A command the node could not start is refused with `command_not_started`.

Node metric commands take the same `shell` and argv forms. On Windows a metric without `shell`
runs in PowerShell; one that runs a single program often is cheaper as an argv, which starts the
program with no shell. A node must run this release's `wsmp` to take a metric command with
`shell` or an argv: saving one for an older node is refused with `upgrade_wsmp`, and one saved
earlier is not sent to it.

Runtime commands can now be argv lists, which every node quotes for its own shell, and a launch
can name its shell (`launch.shell`: `sh`, `pwsh`, `powershell` or `cmd`). On Windows an argv whose
program is an `.exe` starts directly, without the shell.

When `stat` meets a link whose target is missing or outside the node's reach, it now reports that
in `targetType` (`missing` or `denied`) instead of failing the whole result.

## Updating wsmp from the browser (server side)

This server is ready for `wsmp` self-update; the browser **Update** button needs a `wsmp` that
supports it, so the first such release is installed by hand on every node (older agents ignore
the new `agent.update` frame).

- The relay hello now accepts `node.build` (commit, install method, target), `node.environment`
  (`wsl`) and `features.selfUpdate`. Upgrade the **server first**: a newer `wsmp` that sends
  these fields is refused by an older server.
- New frames, extending relay 3.0 in place: `agent.update` (server → node) and
  `agent.update.progress` (node → server). The server sends `agent.update` only to a node that
  reports `features.selfUpdate`, at Full control, owned by the person clicking, with its
  per-node setting on.
- `GET /cli/manifest.json` lists the release the server installs (each target's archive and its
  SHA-256 from the release's `sha256.sum`). It fails closed (503) when the checksums cannot be
  read, and reports `sourceBuild: true` with no archives when the server builds wsmp from source
  (`WMP_CLI_SOURCE_REV`); such servers never offer the browser update.
- `/install.sh` and `/install.ps1` now write an install receipt, `install.json` in the node's
  state directory (`~/.local/state/ws-model-proxy`, `%LOCALAPPDATA%\ws-model-proxy`, or
  `WSMP_STATE_DIR`), so the node knows how it was installed.
- New procedures `nodes.agentUpdate.{overview,start,startAll,stopAll,setPolicy}`: people only
  (the owner's own browser session; never agents, MCP or an admin), not MCP tools.
  "Update all" updates a canary first, then the rest one at a time, and stops at the first
  node that does not confirm. Runs are kept in the database, so a server restart resumes them.
- Database: additive (`db push` safe). `node` gains `cliBuild`, `environment` and
  `agentUpdatePolicy` (default `ALLOWED`); new tables `node_agent_update` and
  `node_agent_update_batch`, with two partial unique indexes in the schema hardening.

## Upgrading: stop runtime instances first

This release records more about each runtime launch (where a multi-node launch
found its head, the GPUs given to each reservation, whether a lost dispatch may
have started something). Launches started by an earlier server do not have
these records, and this release does not reconstruct them.

1. Before deploying, stop every running runtime instance and wait until each
   shows Stopped.
2. Deploy the new server and upgrade every node's `wsmp`.
3. Start the instances again.

An instance left running across the upgrade keeps working, but if the head
node of a multi-node instance is later deleted, its surviving parts may need
Mark as stopped and a manual release instead of an automatic stop.
