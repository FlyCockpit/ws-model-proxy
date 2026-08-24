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
