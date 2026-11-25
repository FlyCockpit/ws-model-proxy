# Relay protocol 4.0

Server and wsmp 1.0 use only relay **4.0**, with WebSocket subprotocol
`ws-model-proxy.relay.v4`. Upgrade the server and every node together when changing
release lines; see [UPGRADING.md](../../../UPGRADING.md).

## Discovery and handshake

Before enrollment, `wsmp login` reads `GET /.well-known/wsmp`:

```json
{
  "serverVersion": "1.0.0",
  "protocolVersion": "4.0",
  "origin": "https://wsmp.example.com",
  "installScript": "/install.sh",
  "enrollPath": "/api/node/enroll"
}
```

The five keys and their types are permanent. The origin is the server's canonical public
origin. The installer and enrollment paths keep the literal values shown above. Released
CLIs parse these fields to decide which side needs upgrading.

The node connects to `/api/cli/ws` with its bearer credential and the v4 subprotocol.
After accepting the upgrade and credential, the server sends `hello.challenge` with a fresh
`nonce` and the canonical `origin`. The node checks the origin and responds with `hello`,
`protocolVersion: "4.0"`, its node identity and signature over the challenge statement,
and its advertised features. The server verifies and registers the node, then sends
`hello.ok` with the protocol version, node ID and `definitionSync`. When `definitionSync`
is `expect`, a `runtime.define` diff follows before jobs; `none` means no diff is expected.
New optional capabilities are advertised through hello features and used only when supported.

## Upgrade refusal

A request offering another WebSocket subprotocol is refused before the upgrade with HTTP
**426 Upgrade Required**. The response retains these keys and types (message text
may vary):

```json
{
  "type": "protocol.error",
  "failure": "protocol_error",
  "code": "upgrade_cli",
  "message": "Unsupported relay websocket subprotocol.",
  "supportedVersions": ["4.0"],
  "supportedSubprotocol": "ws-model-proxy.relay.v4"
}
```

These keys and types must never change: released CLIs parse them to print the reinstall
instructions. A refused 0.4.x node cannot receive a self-update over this connection, but
`wsmp update` on the node still works: it reads `/cli/manifest.json` over HTTPS.
A 1.0 CLI connecting to a 0.4.x server asks the operator to upgrade the server.

## Normative definitions

The code and current cross-language vectors define the complete frame and binary formats:

- [Server frames](../../server/src/relay/frames.ts) — TypeScript schemas.
- [CLI frames](../src/wire/protocol/frames.rs) — Rust frame types.
- [Relay 4.0 fixtures](../tests/fixtures/relay-4.0/) — shared vectors.


## Host access trust

Agent host access (commands and files) lets the agent do whatever the wsmp daemon's OS user
can do, including reading that account's node credential and identity key, editing wsmp's
settings, and starting processes that survive cancellation. It is off until a person enables
Full control at the node; Full control can only be raised locally, and a person can lower it
from the dashboard at any time. File tools' forbidden paths and output masking are guard
rails, not a sandbox. No isolation mode exists.
