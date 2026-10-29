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
