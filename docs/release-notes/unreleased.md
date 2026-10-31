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
