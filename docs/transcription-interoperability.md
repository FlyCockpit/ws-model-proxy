# Transcription interoperability checks

These checks validate WS Model Proxy as a backend-neutral OpenAI-compatible
proxy. They do not install, bundle, or adapt any ASR server.

Set a WMP URL, token, published model ID, and a small audio fixture:

```sh
export WSMP_BASE_URL=http://127.0.0.1:3000/v1
export WSMP_API_TOKEN=replace-me
export WSMP_TRANSCRIPTION_MODEL=owner/cli/endpoint/model
export WSMP_AUDIO_FIXTURE=/absolute/path/to/sample.wav
```

Basic byte-preserving protocol smoke test:

```sh
curl --fail-with-body --no-buffer \
  -H "Authorization: Bearer ${WSMP_API_TOKEN}" \
  -F "model=${WSMP_TRANSCRIPTION_MODEL}" \
  -F "file=@${WSMP_AUDIO_FIXTURE}" \
  -F 'response_format=json' \
  "${WSMP_BASE_URL}/audio/transcriptions"
```

Run the same request directly against the upstream with its upstream model ID
and compare status, content type, and response shape. Transcript wording can be
nondeterministic; the proxy contract is transport and routing equivalence, not
inference equivalence.

Only run advanced checks after explicitly configuring the matching capability.
The fields are forwarded unchanged:

```sh
curl --fail-with-body --no-buffer \
  -H "Authorization: Bearer ${WSMP_API_TOKEN}" \
  -F "model=${WSMP_TRANSCRIPTION_MODEL}" \
  -F "file=@${WSMP_AUDIO_FIXTURE}" \
  -F 'response_format=verbose_json' \
  -F 'timestamp_granularities[]=word' \
  -F 'language=en' \
  "${WSMP_BASE_URL}/audio/transcriptions"

curl --fail-with-body --no-buffer \
  -H "Authorization: Bearer ${WSMP_API_TOKEN}" \
  -F "model=${WSMP_TRANSCRIPTION_MODEL}" \
  -F "file=@${WSMP_AUDIO_FIXTURE}" \
  -F 'stream=true' \
  "${WSMP_BASE_URL}/audio/transcriptions"
```

For a pool, repeat with the pool model ID while each member is independently
disabled in turn. Confirm that known-compatible members are selected before an
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
unmodified upstream response. The harness creates its own user, CLI credential,
model API token, inventory, and model association, derives the published model
from `/v1/models`, and removes the user (with cascading test state) on exit.

Point it only at an isolated, schema-ready E2E Postgres database. The harness
does not apply or reset schema and intentionally refuses to reuse normal server
credentials:

```sh
WSMP_E2E_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/wsmp_e2e \
pnpm test:e2e:transcription
```

The package script builds the server and CLI first. To exercise release-like
artifacts instead, set `WSMP_E2E_SERVER_ENTRY` and `WSMP_E2E_CLI_BINARY` to
prebuilt paths. Child processes receive an explicit environment allowlist, run
in their own process groups, and are terminated and awaited with a SIGKILL
fallback. The test creates CLI configuration and upstream state in a private
temporary directory and removes it on exit. It never installs or uses a
vendor-specific transcription backend.

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
with WMP. Deployments that may run more than one replica should give each replica
its own spool root or perform cleanup only while the whole service is stopped.
