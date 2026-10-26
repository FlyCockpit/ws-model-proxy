# Upgrade notes for the next release

Fold these into `docs/release-notes/X.Y.Z.md` when the release is cut
(`apps/cli/docs/releasing.md`), then delete this file.

## Windows nodes

`wsmp` now runs natively on Windows 11 (x86_64): the relay, `wsmp service` as a Task Scheduler
task, trust, browser terminals on ConPTY, node commands, and runtimes in PowerShell or `cmd`.
Install it from the server with `irm <server>/install.ps1 | iex`, or with the Windows tab of the Nodes page's Add a node. It needs this release's server, which places a
runtime only on nodes whose management modes and shells can run it (a Windows node has no `sh`,
so no `sh` launch lands there). Image paste works in
Windows terminals once the web app is upgraded too: the node quotes the path for the terminal's
shell. Interactive runtime steps open operator terminals there as on Linux. On Windows the node file tools serve reads only (read, stat, list and search), with paths in a POSIX view (`/c/Users/...`). The tools that change files are refused there. The CLI README's Windows
section lists the limits, and the WSL2 alternative.

Runtime commands can now be argv lists, which every node quotes for its own shell, and a launch
can name its shell (`launch.shell`: `sh`, `pwsh`, `powershell` or `cmd`). On Windows an argv whose
program is an `.exe` starts directly, without the shell.

When `stat` meets a link whose target is missing or outside the node's reach, it now reports that
in `targetType` (`missing` or `denied`) instead of failing the whole result.

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
