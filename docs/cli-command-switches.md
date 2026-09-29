# CLI command switches

An MCP agent runs a command on one of your CLIs only when three independent
switches all allow it. The server checks each one fresh on every command
(`apps/server/src/relay/cli-commands.ts`), so changing any of them takes
effect on the next command.

| # | Switch | Who or where | Where you set it |
|---|--------|--------------|------------------|
| 1 | **Token**: `allowCliCommands` plus the `mcp:write` scope | Which agent (per MCP personal token) | Settings, MCP, Personal MCP tokens |
| 2 | **Device grant**: `mcpCommandMode` `off`, `supervised` or `unsupervised` | Which machine, and whether a person confirms each command | Dashboard, CLIs, "MCP commands" on the device |
| 3 | **CLI config**: `wsmp config set-mcp-commands off\|supervised\|unsupervised` | The machine's own local veto, reported to the server on hello | On that machine; restart wsmp |

The **effective mode** of a device is the stricter of switches 2 and 3
(`off` < `supervised` < `unsupervised`). It is also `off` while the CLI is
offline or too old to report its config. The token is separate: it decides
whether this agent may ask at all.

The switches are deliberately separate. The token form never changes a device
grant, and a dashboard grant never overrides the machine's own config.
Consent that lets an agent act on a machine stays a deliberate step made by a
person, on the dashboard or on the machine itself.

## Seeing which switch blocks

- **Dashboard, CLIs page**: under each device's MCP commands control, the
  effective mode and the switch holding it down: the dashboard grant, the
  CLI's own config, both, or the CLI being offline.
- **Token form** (when "Allow CLI commands" is on): each of your devices with
  its effective mode and a link to its grant setting, and a warning when none
  allows commands.
- **MCP `forwarder_cli_devices_list`**: `features.commands` carries `mode`
  (grant), `deviceMode` (CLI config), `effectiveMode`, and
  `limitedBy`: `grant`, `cliConfig`, `both`, `offline` or `null` (nothing
  limits it). `limitedBy` follows the order the relay refuses a command: an
  `off` grant first, then a CLI that is not live, then whichever of the grant
  and the CLI config is lower.
- **MCP errors** name the switch that refused: "switch 1 of 3" (token),
  "switch 2 of 3" (dashboard grant), "switch 3 of 3" (wsmp config). An
  offline CLI is not one of the three switches and says so.

## Supervised commands and the terminal grant

Two tools exist and they are gated differently:

- `forwarder_cli_command_run` runs headless (`sh -c`, no terminal, no stdin)
  and needs the effective mode `unsupervised`.
- `forwarder_cli_supervised_command_start` opens a terminal that shows a
  person the reason and the exact command; nothing runs until they press
  Enter in that command-approval terminal. It needs effective mode
  `supervised` or higher (`unsupervised` also permits it) and a Unix PTY.

Supervised commands do **not** need the separate terminal grant ("Browser
terminal", `allowHumanTerminal`). That grant covers only open-ended terminal
access opened from the dashboard. Each supervised command has its own gate:
a person presses Enter for that one command. The optional per-CLI browser
approval (`wsmp config set-terminal-approval on`) is recommended with
`supervised` because it keeps that guarantee even against a compromised
server; see `apps/cli/README.md`.

## Troubleshooting a refused command

1. Token: is "Allow CLI commands" on for this token (which also needs write
   access), and is the token active?
2. Device grant: is the device's MCP commands control on `supervised` or
   `unsupervised`? Headless `forwarder_cli_command_run` needs `unsupervised`.
3. CLI config: does `wsmp config show` say the same or higher? Restart wsmp
   after `wsmp config set-mcp-commands`.
4. Is the CLI connected? An offline CLI reports no config.
