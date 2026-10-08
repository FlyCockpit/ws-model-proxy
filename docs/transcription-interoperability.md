# Transcription interoperability checks

These checks validate WS Model Proxy as a backend-neutral OpenAI-compatible
proxy. They do not install, bundle, or adapt any ASR server.

Set a WMP URL, an API key, the callable ID of a transcription pool, and a small audio fixture:

```sh
export WSMP_BASE_URL=http://127.0.0.1:3000/v1
export WSMP_API_KEY=wsmp_key_replace-me
export WSMP_TRANSCRIPTION_MODEL=owner/pool
export WSMP_AUDIO_FIXTURE=/absolute/path/to/sample.wav
```

Basic byte-preserving protocol smoke test:

```sh
curl --fail-with-body --no-buffer \
  -H "Authorization: Bearer ${WSMP_API_KEY}" \
  -F "model=${WSMP_TRANSCRIPTION_MODEL}" \
  -F "file=@${WSMP_AUDIO_FIXTURE}" \
  -F 'response_format=json' \
  "${WSMP_BASE_URL}/audio/transcriptions"
```

Run the same request directly against the runtime with its served model ID
and compare status, content type, and response shape. Transcript wording can be
nondeterministic; the proxy contract is transport and routing equivalence, not
inference equivalence.

Only run advanced checks after explicitly configuring the matching capability.
The fields are forwarded unchanged:

```sh
curl --fail-with-body --no-buffer \
  -H "Authorization: Bearer ${WSMP_API_KEY}" \
  -F "model=${WSMP_TRANSCRIPTION_MODEL}" \
  -F "file=@${WSMP_AUDIO_FIXTURE}" \
  -F 'response_format=verbose_json' \
  -F 'timestamp_granularities[]=word' \
  -F 'language=en' \
  "${WSMP_BASE_URL}/audio/transcriptions"

curl --fail-with-body --no-buffer \
  -H "Authorization: Bearer ${WSMP_API_KEY}" \
  -F "model=${WSMP_TRANSCRIPTION_MODEL}" \
  -F "file=@${WSMP_AUDIO_FIXTURE}" \
  -F 'stream=true' \
  "${WSMP_BASE_URL}/audio/transcriptions"
```

For a pool with several members, repeat while each member is disabled in turn. Confirm that known-compatible members are selected before an
opted-in unknown basic fallback and that no retry occurs after response headers
or bytes reach the caller.

For a manual throughput run, use a non-sensitive fixture and record fixture
size, concurrency, wall time, WMP/server versions, upstream server/version, and
hardware. Exercise `1`, `2`, and `4` concurrent requests and monitor WMP memory
and spool usage. Do not use transcript content, filenames, language hints, or
audio bytes as metrics labels or logs.

External ASR checks are intentionally manual or optional CI jobs. The required
CI contract suite uses a deterministic generic OpenAI-compatible test server so
third-party availability and GPU access cannot determine correctness.

## Deterministic full-stack relay test

The opt-in harness starts a deterministic local mock ASR server, a prebuilt WMP
server, and the prebuilt Rust `wsmp` relay, connects them over the production
WebSocket protocol, and sends multipart audio through the public model API. It
asserts model rewriting, scalar-field passthrough, byte preservation, and the
unmodified upstream response. The harness creates its own user, node credential,
API key, runtime and pool, derives the callable ID from `/v1/models`, and removes
the user (with cascading test state) on exit.

> Both e2e harnesses (`scripts/e2e/transcription-relay.mjs` and
> `realtime-transcription-relay.mjs`) still seed the 0.3 tables and are not yet ported to
> the 0.4.0 schema; until they are, they fail at setup.

Point it only at an isolated, schema-ready E2E Postgres database. The harness
does not apply or reset schema and intentionally refuses to reuse normal server
credentials:

```sh
WSMP_E2E_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/wsmp_e2e \
pnpm test:e2e:transcription
```

The package script builds the server and `wsmp` first. To exercise release-like
artifacts instead, set `WSMP_E2E_SERVER_ENTRY` and `WSMP_E2E_CLI_BINARY` to
prebuilt paths. Child processes receive an explicit environment allowlist, run
in their own process groups, and are terminated and awaited with a SIGKILL
fallback. The test creates `wsmp` configuration and upstream state in a private
temporary directory and removes it on exit. It never installs or uses a
vendor-specific transcription backend.

## Live transcription (`/v1/realtime`)

Live sessions stream microphone audio to a speech-to-text pool over a
WebSocket and return results while the session runs. They follow the OpenAI
Realtime GA transcription events; WMP terminates that protocol and relays only
raw PCM and normalized results to the node, so engine differences stay in
`wsmp`'s adapter.

### Runtime definition

A transcription runtime opts in per served model with a `realtime` block in the
model's transcription profile (`models[].transcription.realtime` in the runtime
definition). Without it the served model takes no live sessions.

```json
{ "adapter": "segmented", "maxItemSeconds": 30, "maxSessions": 4 }
```

- `adapter: "vllm"` bridges to vLLM's own `/v1/realtime` and returns partial
  results while the person speaks. Use it for vLLM realtime models
  (Voxtral-Mini-4B-Realtime, Qwen3-ASR realtime) on a runtime whose engine is
  `vllm` or `other`. It takes no language or prompt.
- `adapter: "segmented"` works with any engine that serves
  `/v1/audio/transcriptions`: `wsmp` collects each turn the client commits,
  sends it as a 16 kHz WAV file, and returns one result per turn.
- `maxItemSeconds` (5–600, at most 120 for `segmented`; default 300 for
  `vllm`, 30 for `segmented`) ends a turn the client has not committed, since
  there is no voice activity detection. `maxSessions` (1–8) caps live sessions
  per instance; a node serves at most 8.

Engine notes:

- **whisper.cpp server.** Its transcription route is `/inference` unless
  changed. With `segmented`, start it with
  `--inference-path /v1/audio/transcriptions`. `--convert` is not needed for
  live sessions (`wsmp` sends 16 kHz WAV); keep it if the same server also
  serves uploads in other formats.
- **Voxtral realtime on vLLM.** A turn grows one context, so
  `--max-model-len` bounds how long a turn can be; a turn that outgrows it
  fails part-way. Keep `maxItemSeconds` well inside it (600 s of audio is
  roughly 7.5k audio tokens). Qwen3-ASR realtime is not affected.

The runtime definition is the only source: a node that reports `realtime` for a
served model its definition does not declare is never routed to. A session opens
only on a pool member whose instance is ready on an online node and fully healthy;
a pool whose members are all degraded or recovering refuses it with close code 1013. A member that refuses sessions for a configuration
reason (for example no `/v1/realtime` route) is logged and is not marked
unhealthy for HTTP traffic. `GET /v1/models` marks models with a live-capable
member with `supports_realtime_transcription` (a hint; routing decides).

### Client usage

Connect to `GET /v1/realtime?intent=transcription` (optionally `&model=…`)
with an API key, either as `Authorization: Bearer <key>` or, from a
browser, as the subprotocol pair `realtime` and
`openai-insecure-api-key.<key>` (the server selects only `realtime`). Keys in
the URL are refused. (The **Test** page's live speech-to-text panel runs the same
session through its own socket, signed in with the browser session and
recorded as test usage; it needs no key, and it can also test one of your served
models directly.) Then:

1. Receive `session.created`.
2. Send
   `{"type":"session.update","session":{"type":"transcription","audio":{"input":{"transcription":{"model":"owner/pool"}}}}}`
   unless the URL named the model. `turn_detection` and `noise_reduction` must
   be null; `format` is `audio/pcm` at 24000 Hz.
3. Send `input_audio_buffer.append` with base64 16-bit little-endian mono PCM
   at 24 kHz (at most 512 KiB of base64 per event; 20–100 ms per event is
   typical), then `input_audio_buffer.commit` at the end of each turn.
4. Read `conversation.item.input_audio_transcription.delta`, then `completed`
   (with `usage: {"type":"duration","seconds":…}`) or `failed`.

```js
import WebSocket from "ws";

const socket = new WebSocket(
  `${base.replace("http", "ws")}/v1/realtime?intent=transcription&model=${encodeURIComponent(model)}`,
  { headers: { authorization: `Bearer ${token}` } },
);
socket.on("message", (data) => {
  const event = JSON.parse(data);
  if (event.type === "conversation.item.input_audio_transcription.completed")
    console.log(event.transcript);
});
socket.on("open", () => {
  for (const chunk of pcm24kChunks) {
    socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: chunk.toString("base64") }));
  }
  socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
});
```

Limits and closes: 4 sessions per API key, 8 per user, 30 minutes per session,
120 s without audio, 400 events per 10 s. An `error` event precedes every
close other than 1000. 1001 is a server shutdown, 1008 lost access or refused,
1011 an upstream or node failure, 1013 busy or a backlog. There is no failover
after a session opens; reconnect. Access is checked at open and every 60
seconds: a revoked key, a ban or a deleted user ends sessions at once in the
server process that made the change (other processes end theirs within 60 s);
an expired key or a change to the key's pools that removes the pool ends them
within 60 s.

Each opened session is recorded as one request (`audio.realtime_transcription`)
with the forwarded audio duration (`audioInputMs`) and any engine token counts;
audio and transcripts are never stored or logged.

### Deterministic live-session test

`pnpm test:e2e:realtime-transcription` builds the server and runs
`scripts/e2e/realtime-transcription-relay.mjs` against an isolated,
schema-ready Postgres database:

```sh
WSMP_E2E_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/wsmp_e2e \
pnpm test:e2e:realtime-transcription
```

It starts the prebuilt server, seeds a user, credentials and a running
transcription runtime in a pool, and drives an OpenAI-shaped WebSocket client
against a protocol-faithful fake node. That checks upgrade auth (header and
subprotocol, refused URL keys), routing to the pool member, the open,
audio coalescing and credits, results with duration usage, client close
reaching the node, a busy refusal (1013), a node disconnect (1011), the
request rows and rollups, and that no audio or transcript reaches logs or
metadata. Running a real transcription runtime needs a node and an engine, so
the Rust session and adapters are covered by `wsmp`'s own tests against fake
vLLM and file engines instead. (Not yet ported to the 0.4.0 schema; see above.)

## Spool orphan cleanup

WMP creates a private `instance-*` directory below
`MODEL_API_TRANSCRIPTION_SPOOL_DIR` (or the documented OS-temporary default).
Normal request cleanup removes every `upload-*` directory. A hard kill or host
crash can leave an instance directory behind.

WMP deliberately does not delete old-looking instance directories at startup:
file age cannot prove that another WMP process is dead. To clean orphans safely,
stop every WMP process that shares the configured spool root, verify no process
has an open file below that exact directory (for example with `lsof +D`), and
then remove only its `instance-*` children. Never run this cleanup concurrently
with WMP. A server that may run more than one replica should give each replica
its own spool root or perform cleanup only while the whole service is stopped.
