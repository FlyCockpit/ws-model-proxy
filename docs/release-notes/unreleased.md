# Unreleased: upgrade notes

## Deploy with `APPLY_SCHEMA=safe`

The next deploy must run with `APPLY_SCHEMA=safe` once, so schema hardening replaces the
`node_trust_lower_shape` check constraint. `off` keeps the old constraint and the bug below.

## Fixed: a node lowered to Relay only from the browser could not reconnect

Lowering a node's trust on its page (Full control to Relay only) left the node unable to save
its trust report, and every reconnect after that failed with "node registration failed"; the
node stayed offline until it was deleted and enrolled again. Once the node applies a lowering,
the server keeps who asked for it, so the page can say who lowered the node, and a database
check did not allow that. The check now allows it.

No `wsmp` upgrade is needed. A node stuck this way comes back online by itself after the
deploy, at its next reconnect.

## Live updates for nodes

Pages now update as soon as one of your nodes connects, disconnects, changes trust, reports
update progress, enrolls or is deleted, instead of polling every few seconds. Each signed-in
tab holds one server-sent events stream, `GET /api/dashboard/events`. Signing out also closes
that session's terminals at once, not within a minute.

A reverse proxy must not buffer that path: Traefik (Dokploy) and Caddy stream it as they are.
If something in front does buffer it, the pages fall back to their old polling, and the Nodes
and Terminals pages say "Live updates paused".

## MCP tool results

- A refusal's text now starts with its reason (`shell_unavailable: Node … has no pwsh …`), for
  MCP clients that show agents only the text. The structured result is unchanged.
- "The relay is not available" and "the node did not answer" keep their code
  (`SERVICE_UNAVAILABLE`, `BAD_GATEWAY`) and message instead of `INTERNAL_ERROR`.
- Each tool's description ends with `(schema <6 hex>)`, a digest of its input schema. It
  changes only when that tool's input changes, so an agent can tell its client holds an old
  copy of the tool.
- A command's `finishedAt` is its server start plus the run time the node measured. Before,
  a node whose clock ran behind the server's showed fast commands as ending when they started.

## New: node commands say which shell ran them

`node_command_run` and `node_command_get` (and `nodes.commands.run` / `get`) now answer
`ranWith: { shell, mode }`: the shell that read the command (`sh`, `pwsh`, `powershell` or `cmd`;
null for a program started directly) and `mode`, `shell` or `direct` (an argv started as a
program, each argument exact; a Windows `.bat` or `.cmd` is `direct` with `shell: "cmd"`).

The field appears once a node runs a `wsmp` release that reports it; commands on nodes with an
older `wsmp` have no `ranWith`, and keep working as before. It is stored in two new nullable
`node_command` columns (`ranMode`, `ranShell`), so this deploy needs `APPLY_SCHEMA=safe` (already
needed above).

## Homebrew updates install only the version asked for, with "Install anyway"

Updating a Homebrew node from the browser installed whatever `flycockpit/tap` had at that moment.
When the tap was ahead of this server (or behind it, on a self-hosted server built from a newer
commit), Homebrew switched the node to that other version and only then reported a version
mismatch; the node ran it after its next restart. Now the node refreshes the tap first
(`brew update`) and refuses before anything is installed, and before it waits for the node to be
idle, when the tap does not have exactly the server's version. The refusal names the tap's
version in its text (telling you to upgrade the server when the tap is ahead of it, or that the
tap does not have the server's version yet when it is behind) and, to a server that says it
accepts it, in a new optional `agent.update.progress` field, `availableVersion` (sent only with
`refused` / `version_mismatch`). The server says so in `hello.ok`
(`features.agentUpdateAvailableVersion`); the node's hello is unchanged.

When the tap's version is newer than the version the node runs, the node's page then offers
**Install anyway**: with a confirmation, it installs the tap's version without upgrading the
server. A tap that is not ahead of the node gets the refusal alone. Upgrading the server to that version is still the usual fix. "Update
all" never does this. A node that runs a newer wsmp than the server now shows **Newer than this
server** instead of **Outdated**, and "Update all" passes it over as current.

- Install anyway is offered only after a refusal that carried `availableVersion`, from the wsmp
  the node still runs (same version and build): only a wsmp from this release sends it, and it
  checks the tap before installing. Older nodes are never offered it and update exactly as
  before.
- Compatible both ways: a `wsmp` from this release still works with a 0.4.3 server (it then
  refuses the same way, with the tap's version only in the message), and older `wsmp` work with
  this server.
- The node checks the tap's version once more and runs `brew upgrade` while it holds Homebrew's
  own update lock, so an ordinary `brew update` (yours, or Homebrew's auto-update in another
  shell) cannot change the tap meanwhile: it does not wait for the lock, it fails at once with
  "Another `brew update` process is already running", and has to be run again. The node checks that it holds the lock file the path names, and takes it
  again if `brew cleanup` replaced it; a lock file that is not a plain file (a link, a pipe) is an
  error, not a wait.
- Known limitation: a `brew update` that was already starting when a `brew cleanup` replaced the
  lock file can still move the tap during the update. This is a gap in Homebrew's own locking that
  wsmp cannot close. A tap changed by hand (`git` in the tap, `brew update-reset`) is not covered
  either. The version check after the upgrade reports both as a failed update (version
  mismatch).
- Known limitation: the lock lasts as long as the `wsmp` holding it. If `wsmp` itself dies
  (killed, or a crash) while its `brew upgrade` keeps running, the lock is let go early, and a
  `brew update` that starts in that window could change the tap, so the upgrade could install
  another version. The version `wsmp` reports when it starts again shows it.
- `brew upgrade` on the node is now stopped after 10 minutes (it had no limit). `wsmp update` on a
  Homebrew node refuses the same way when the tap has another version.
- Lowering the node to Relay only, or turning remote updates off on it, now also stops a Homebrew
  update that is refreshing the tap or checking its version: the node asks again right before it
  refreshes the tap, moves the service and upgrades.
- Before a Homebrew upgrade the node writes its relay service again, the way `wsmp service install`
  writes it now: onto Homebrew's stable `opt/wsmp/bin/wsmp` path, with the config, state and
  `PATH` of the `wsmp` doing the update (the relay itself, or the shell that runs `wsmp update`).
  This covers every service file `wsmp service install` wrote, from any release: one on an old
  versioned `Cellar` path (moved, as before), one from an older template, one cut short, one with
  another mode, and one edited by hand. **Hand edits to a service file that `wsmp service install`
  wrote (the systemd unit; the macOS LaunchAgent plist and its wrapper) are replaced on update.**
  A file that is already exactly what install writes is not touched. A service file written by
  hand (not starting the way wsmp's do) is left as it is, unless it runs a versioned `Cellar`
  path: then the update is refused with wsmp not upgraded. A service file that is there but
  broken (a link to nothing, a directory, a pipe; it is never read then, so a pipe cannot hang the
  update) is refused the same way (run `wsmp service install`). No service at all is fine, as
  before. Whether the new build runs is checked by running it: after `brew upgrade` the node runs
  the same `opt/wsmp/bin/wsmp` the service now starts with `--version`, and a build that does not
  run (or is another version) fails the update before the relay restarts.
- On macOS, `wsmp update` on a Homebrew node now restarts the relay by loading its LaunchAgent
  again (`launchctl bootout`, then `bootstrap`), so launchd uses the plist as it is on disk.
  `bootout` returns before launchd has unloaded the agent, so wsmp waits until it is gone, and
  tries `bootstrap` again while it fails, all within 3 minutes. If launchd still does not load
  it, `wsmp update` fails with an error that says to run `wsmp service install`, rather than
  leave the relay unloaded without a word. `wsmp service install` loads the LaunchAgent the same
  way (when it is already loaded: `bootout`, wait, `bootstrap` tried again); if launchd still does
  not load it, it says to run it again or to run `launchctl bootstrap` by hand. This has not yet
  been run on a Mac.
- Known limitation (macOS): an update from the browser does not reload the LaunchAgent. The
  relay exits and launchd starts the definition it loaded. A LaunchAgent plist that was edited
  by hand and is loaded therefore keeps running what launchd loaded, even though the update
  wrote the plist again: the update may not confirm, or the relay may go offline. Run `wsmp
  service install` to load the rewritten plist. `wsmp update` is not a fix for this: when wsmp
  is already current it returns early and reloads nothing. The wrapper, which runs wsmp, is read
  at every start, so a plist that wsmp wrote and nobody edited is not affected.
- A service file is never written with a value its reader would take differently: a path or a
  pinned value with a control character (a newline, a carriage return, NUL, a tab), or, for the
  systemd unit, a program path with a quote or a backslash (systemd refuses to run those). `wsmp
  service install` and the Homebrew update both refuse such a value before anything is written,
  and the update refuses before it touches the keg. Before, a newline in such a path could
  produce a unit systemd rejects, while the update still reported success.
- The new service file replaces the old one whole (a failed write leaves the old one, still
  runnable). Each update syncs the service file and its directory again, and on Linux, when a
  service unit exists, runs `systemctl --user daemon-reload` before it upgrades, so a sync or
  reload that failed once is done by the next update instead of being skipped. `wsmp service
  install` writes its files the same way. A `wsmp` killed while it writes one can leave a small
  `.wsmp-*.tmp` file beside it, which is safe to delete.
- Refusals after the tap was refreshed now say "wsmp was not upgraded" instead of "nothing was
  changed", and the node's page no longer says "nothing was installed" after a Homebrew upgrade
  ran: it says the installed wsmp is not the version asked for, or its version could not be
  checked. The page words a past update by how that update was installed, also when the node has
  been reinstalled another way since. Its texts no longer say every update installs the server's
  version (Install anyway does not) or rolls back by itself (Homebrew cannot).
- In the browser, turning updates off for a node, or lowering its trust, and an update request
  (or "Install anyway", "Update all", or forcing a waiting update) no longer race: the server
  takes them one after the other. A change saved before the request is claimed refuses it, so it
  never reaches the node; a request already claimed goes on (the node itself still checks its
  trust and its remote-update setting before it installs).
- Two new nullable `node_agent_update` columns, `artifactSha256` and `availableVersion`
  (`APPLY_SCHEMA=safe`, already needed above).

## Fixed: forcing a waiting update could send a rebuilt release

"Stop instances and update now" on an update that waits for idle resent the update with the
archive the server offered at that moment, checking only the version. A redeploy in between that
rebuilt the same version sent the node another archive than the one requested. The update now
keeps the checksum of the archive it was sent, and a forced resend goes out only while the server
still offers that archive; otherwise it is refused ("no release binary to offer"). Updates
requested before this deploy kept no checksum and cannot be forced: they still install once the
node is idle, or end after 30 minutes.

## Fixed: update commands on the node could stall until their time limit

The commands `wsmp` runs while updating (unpacking the archive, checking the new build, the
service manager, Homebrew) read their output one stream after the other: a command that wrote a
lot to its error output first stalled until its time limit and the update failed. They now share
the bounded runner telemetry commands use: both streams are read at once, in turns, so a stream
that never runs dry cannot hold the other one or the time limit off; output past 1 MiB is dropped
instead of stalling, everything a command started is ended at its time limit, and a helper that
keeps the output open can no longer hold the update past it. The service-manager commands an
update or a rollback runs (`systemctl --user daemon-reload` / `restart`, `launchctl`) run the same
way, with a 3-minute limit.
