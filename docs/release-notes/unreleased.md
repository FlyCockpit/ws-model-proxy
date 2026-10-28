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
Git Bash's `sh`; name `shell: "cmd"`
for Command Prompt, which now gets the text exactly as sent. A node must run this release's
`wsmp` for `shell` or an argv: an older one refuses the command, and the server says to upgrade
it.

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
