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
  before. When a build commit is unknown (on the node or in the stored refusal), the version
  alone does not tell builds apart, so the offer holds only on the connection the refusal
  arrived on: after the node reconnects it needs a new refusal (press Update again). A waiting
  Install anyway update is not resent forced after such a reconnect either.
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
  refreshes the tap, moves the service and upgrades. A self-replace update asks again after its
  rollback is armed, right before the new build is moved into place: lowered while the service
  manager registers the rollback, it is refused, the rollback is removed and the old build stays.
  An update waiting for a busy node to go idle stops waiting as soon as the node is lowered (or
  remote updates are turned off), instead of holding new work until the node is idle or 30
  minutes pass. The update reads the relay's own trust at each of these steps, so a lowering
  counts from the moment it happens (before, it was seen only at the relay's next pass over the
  update), and an update that was lowered once stays refused even if the node is raised to Full
  control again during it.
- A forced update (and a forced resend of one waiting for idle) is never sent to a node whose
  operator turned remote updates off: the server checks the node's own setting, as the session
  reports it at that moment, when it claims the update and again right before it sends it, as it
  does for a first update. It no longer stops a node's running instances for a forced update
  unless the update is still allowed then (owner's session, Full control, browser updates on,
  remote updates on). The node's page no longer offers Force on such a node.
- The server accepts an update version (the one it sends, and the one a Homebrew node offers for
  "Install anyway") only in the form the node reads one: at most 64 characters, no leading zeros.
  An offered version the node could not install is dropped (no offer); the refusal is still
  stored. The server orders versions exactly as the node does, including an empty pre-release
  before build metadata (`1.2.3-+b` is older than `1.2.3`); both check the same list of pairs.
- The node takes Homebrew's update lock in exactly the prefix `brew --prefix` prints: only the
  line ending is taken off (a prefix ending in a space keeps it). Output that is not one line of
  UTF-8 naming an absolute path stops the update before `brew upgrade`.
- On macOS, the LaunchAgent plist names its wrapper by an absolute path even when `wsmp service
  install` or `wsmp update` runs with a relative `WSMP_STATE_DIR`.
- Before a Homebrew upgrade the node writes its relay service again, the way `wsmp service install`
  writes it now: onto Homebrew's stable `opt/wsmp/bin/wsmp` path, with the config, state and
  `PATH` of the `wsmp` doing the update (the relay itself, or the shell that runs `wsmp update`).
  This covers every service file `wsmp service install` wrote, from any release: one on an old
  versioned `Cellar` path (moved, as before), one from an older template, one cut short after its
  opening lines, one with another mode, and one edited by hand. **Hand edits to a service file that `wsmp service install`
  wrote (the systemd unit; the macOS LaunchAgent plist and its wrapper) are replaced on update.**
  A file that is already exactly what install writes is not touched. On macOS a LaunchAgent plist
  whose `Label` is `com.flycockpit.wsmp` (read with `plutil`) is wsmp's, even after `plutil`,
  `defaults` or Xcode saved it again with its keys sorted or in the binary format, and is written
  again too. **Any other service file (written by hand or by another tool: not starting with the
  complete opening lines wsmp's do, and for the plist, another label or one `plutil` cannot read)
  stops a Homebrew update before the keg changes, whatever it runs**, with nothing changed and
  wsmp not upgraded: wsmp cannot tell what such a file starts, so it cannot tell whether the
  restart would run the new build. This includes a file that has only part of that opening: an
  empty file, one cut short inside it, or one that merely starts the same way (a wrapper that is
  just `#!/bin/sh`). A file wsmp wrote that was cut short that early is refused the same way, and
  `wsmp service install` fixes it. The refusal says to run `wsmp service install` and update
  again, or to update by hand.
  The file's text is not inspected. A service file that is there but
  broken (a link to nothing, a directory, a pipe; it is never read then, so a pipe cannot hang the
  update) is refused the same way (run `wsmp service install`). No service at all is fine, as
  before. Whether the new build runs is checked by running it: after `brew upgrade` the node runs
  the same `opt/wsmp/bin/wsmp` the service now starts with `--version`, and a build that does not
  run (or is another version) fails the update before the relay restarts.
- On macOS, `wsmp update` on a Homebrew node now restarts the relay by loading its LaunchAgent
  again (`launchctl bootout`, then `bootstrap`), so launchd uses the plist as it is on disk.
  `bootout` returns before launchd has unloaded the agent, so wsmp waits until it is gone, and
  tries `bootstrap` again while it fails, all within 3 minutes. A look at launchd that gives no
  answer (`launchctl` could not run, or failed in another way than "not loaded") is asked again,
  never taken to mean the agent is unloaded. If launchd still does not load it, `wsmp update`
  fails with an error that says to run `wsmp service install`, rather than leave the relay
  unloaded without a word. `wsmp service install` loads the LaunchAgent the same
  way (when it is already loaded: `bootout`, wait, `bootstrap` tried again); if launchd still does
  not load it, it says to run it again or to run `launchctl bootstrap` by hand. Tested on a Mac
  (Apple Silicon, Homebrew): reloads, repeated reloads, an unloaded agent and two installs in a
  row all came back loaded; the retry and the error were tested with a simulated
  `Bootstrap failed: 5`.
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
- The rollback job an update arms (the dead-man) now gets its state directory exactly as it is. A
  `$` in it (`${HOME}`, `$$`) is written `$$` in the systemd unit, which systemd would otherwise
  have expanded, and a path that is not UTF-8 is refused before the job is written (it was
  written with U+FFFD in its place). A relative state directory (or previous binary) is made
  absolute, against the directory of the `wsmp` doing the update, before the job is written: the
  scheduler starts the job in a directory of its own. An empty one is refused. In each case the
  rollback looked in another directory, found no update and rolled nothing back.
  `wsmp service install`'s hint for loading the LaunchAgent by
  hand now quotes the plist's path.
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
- In the browser, turning updates off for a node, lowering its trust, the node turning remote
  updates off, and an update request (or "Install anyway", "Update all", or forcing a waiting
  update) no longer race. Each of them takes the node's update lock, and the server checks
  again, under that lock, right before the update is sent and right before a forced update's
  stop of the node's instances is recorded. A change saved before that point refuses the update:
  nothing is sent, nothing is stopped, and the request is undone. Before, a change saved after
  the request was accepted, but before it went out, did not stop it. A change saved after the
  update was sent does not call it back (the node itself still checks its trust and its
  remote-update setting before it installs). The same check also reads the node's connection as
  the server stored it: an update (and "Install anyway") is never sent on a connection that a
  newer connection of the same node has replaced, also in the moment before this server process
  switched over to the new one. And the request itself must still be open: one that timed out,
  or that the node ended, between the request and the send is not sent. A forced update's stop
  of the node's instances is decided when it is recorded: once recorded it is always delivered,
  and a change saved after that does not call it back.
- Three new nullable `node_agent_update` columns, `artifactSha256`, `availableVersion` and
  `availableGeneration` (`APPLY_SCHEMA=safe`, already needed above).
- A Homebrew update that waited for the node to become idle, and then for Homebrew's own update
  lock (another `brew update` running), could be marked timed out, which also stopped "Update
  all", even though it was still working. The node now reports "downloading" as soon as it is
  idle, so the wait for the lock gets the download time limit, not what is left of the
  30-minute idle wait.
- An update refused right before the swap (the node was lowered, or remote updates were turned
  off) while the node could not write its update state no longer blocks every later update until
  `wsmp` restarts. The node tries the write again, and while it still cannot, it keeps the
  rollback job armed. When the job runs, it records the end and nothing is moved. The same holds
  when the swap itself fails. If the rollback job could not be armed either, there is no job to
  record the end: the next update (from the browser, or `wsmp update` on the node) now records
  it itself and goes on, instead of being refused until `wsmp` restarts. It does so only when no
  update is running (it holds the update lock), no rollback job is registered, and the new build
  was never moved into place.
- A rollback that was cut short after it put the previous build back (a crash, or a failed write
  of the update state) is no longer mistaken for an unconfirmed update. The node records the
  rollback before it moves anything, so whatever runs next finishes it: the rollback job, the
  relay starting again, or the rollback after too many unconfirmed starts. Before, the job found
  no rollback copy and gave up, and the new build, still running, could confirm itself although
  the previous build was installed again. A confirmation now also checks that the installed
  binary is the new build. This holds for both rollbacks: the job's, and the one after too many
  unconfirmed starts. Two optional fields in the node's `update/state.json` (`rollingBack`,
  `restartPending`) carry this; a wsmp of an earlier release that starts after a rollback
  ignores them.
- A rollback whose restart of the relay service fails no longer removes its rollback job and
  reports success. The job tries the restart three times, then exits with an error and keeps
  itself, and its next run restarts the relay. The job no longer runs `wsmp.prev`, which the
  rollback moves back into place (so a second run found no program to start): it runs its own
  copy of the previous build, `.wsmp-recovery-<update id>` beside the binary (a hard link on
  Linux and macOS, a copy where linking fails and on Windows), made and checked before the job is
  armed and never moved by the swap or the rollback. The copy is removed once the job is gone and
  nothing is owed (the rollback recorded and the relay restarted); one the job could not remove
  itself (on macOS removing the job ends it first; on Windows a running program cannot be
  deleted) goes at the next relay start, confirmation or update. A job that a development build
  of this release armed still runs `wsmp.prev`: the rollback puts the restored build at that
  path again, so its next run starts too. An update started by a released wsmp (0.4.3 or older)
  runs that release's rollback job, unchanged. `update/state.json` records the copy in one more
  optional field, `recoveryPath`, which earlier releases ignore. The jobs now run again after a
  failed run: on Linux a minute later (`Restart=on-failure` in `wsmp-update-deadman.service`), on macOS a minute
  later (`KeepAlive` with `SuccessfulExit` false), on Windows every 10 minutes (the deadline
  trigger repeats until the task is removed). Before, each was one run only. Only the Linux job
  was tested here, by starting the program its unit names, after a real rollback, with a
  stand-in `systemctl`; the macOS and Windows definitions were checked as text.

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
instead of stalling, and at its time limit the command is ended together with its process group
(on Linux and macOS) or its job (on Windows). A helper that keeps the output open can no longer
hold the update past it. On Linux and macOS, a helper that detached into a session of its own is
outside that group and can keep running after the limit. The service-manager commands an
update or a rollback runs (`systemctl --user daemon-reload` / `restart`, `launchctl`) run the same
way, with a 3-minute limit.

## Touch scrolling in the browser terminal

On a phone or tablet, swiping up or down in the terminal now scrolls it the way a mouse wheel
does on a desktop: inside tmux with `mouse on` (and other apps that use the mouse) it scrolls
the app's history, on a full-screen app without the mouse it sends arrow keys, and at a plain
shell it scrolls the terminal's scrollback. A swipe never counts as a click, so it does not let
a program copy to the clipboard. What it sends is your input, like a key you press: if someone
else took over typing while your swipe (or its coasting) is still scrolling, it takes typing
back for you. A tap still focuses the terminal and opens the keyboard, and a program may copy
to the clipboard right after it. A tap is a finger that lifts where it went down, within a small movement
threshold: one that lifts farther away is not a tap, even if the browser reported no movement before it lifted. How long
the finger stays down does not matter: a long press that does not move is a tap too. A long
press can also focus the terminal while the finger is still down (the browser's long-press menu
does this); that sends no keystrokes or mouse clicks, does not take over typing and does not let a
program copy to the clipboard. A program that asked to be told about focus is told the terminal
gained focus. A touch
that is still down when the terminal reattaches, resets or is hidden (or when someone else starts typing)
does nothing when it lifts: tap again. Neither does a touch with a second finger on the screen,
even one outside the terminal, nor a finger still resting on a terminal whose tab closes or reloads: it does not
click into the terminal that takes its place. On a device with both a mouse and a touch screen,
a tap made while a mouse button is held down in a terminal clicks into no terminal and does not
end that mouse drag, and pressing a second mouse or pen button during a drag works as before.
In Safari and Firefox, which do not mark the mouse events a touch makes, three of these protections
do not apply, and those cases behave as they did before this release. A finger resting on a
terminal that is replaced can still click into the terminal that takes its place. A long-press
menu that the browser does not mark as a touch's can focus a terminal you did not tap (and may
open the keyboard); it sends no keystrokes or mouse clicks, does not take over typing and does
not let a program copy (a program that asked to be told about focus is told the terminal gained
focus). And on a device
with both a mouse and a touch screen, if a mouse button is held down in a terminal and a finger taps
outside every terminal, the browser's release for that tap looks the same as the mouse's own: the
terminal sends the program a mouse release you did not make, as your input. That input can also
take typing back for you from someone who took it over meanwhile: while the terminal box follows
their screen size, only if the tap comes within half a second of the mouse press; while their
screen size is not known yet, at any time. While someone else is typing and the terminal box
follows their screen size, a swipe pans the box as before and sends nothing; while their size is
not known yet, a swipe scrolls and takes typing back for you, as a key would. A swipe that starts
on the terminal no longer scrolls the page.

The mouse wheel on a desktop is now sent only while you are the one typing: if someone else takes
over while a wheel scroll is on its way, it is dropped instead of taking typing back from them.
One case is not covered yet and behaves as before this release: a wheel scroll that had already
left your browser when they took over can still reach the computer after their takeover, and then
takes typing back for you.
