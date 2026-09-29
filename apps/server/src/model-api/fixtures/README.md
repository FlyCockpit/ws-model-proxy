# Protocol fixtures

`anthropic-2023-06-01.json` is a synthetic conformance fixture derived from the
published Anthropic API documentation URLs recorded in its `sources` field. It
is not an upstream capture and must not be presented as one. The `derivedAt`
field records when the synthetic fixture was derived, not when an upstream
response was captured. Identifiers, token
counts, model names, and text are illustrative; the header names, envelope
fields, count-token shape, error envelope, and SSE event ordering are the
published-spec-derived evidence exercised by the route tests.

When the fixture is changed, keep its source URLs and `provenance.assertions`
aligned with the exact protocol properties the tests consume.

`openrouter-usage.json` is a synthetic OpenRouter usage fixture derived from the
published `ResponseUsage` type and usage-accounting example recorded in its
`provenance.sources`. It is not an upstream capture. It carries every key the
OpenRouter Chat usage dialect accepts (`is_byok`, `cost_details`,
`server_tool_use`, zero `video_tokens` / `image_tokens`) in non-stream and
stream (`stream` lines joined with blank lines) form; its stream is BYOK. The
stream ends with the documented usage chunk whose single content-free choice
repeats the `finish_reason`.

`openrouter-live/*.raw` are live OpenRouter responses captured on 2026-09-29
(`anthropic/claude-haiku-4.5`, provider Amazon Bedrock, a ~7.6k-token cached
system prompt): for Chat Completions and Messages, a cache-write call and a
cache-read call, each non-stream and stream; for Responses, one non-stream and
one stream call. They are unmodified response bodies and contain no
credentials or prompt text beyond the model's short reply. Tests derive BYOK and
malformed variants from them in memory.
