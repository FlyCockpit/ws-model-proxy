# Protocol fixtures

`published/manifest.json` records the published protocol documents used to derive
the version-sensitive request and SSE shapes. These are provenance fixtures, not
snapshots of WSMP output. `adapter-golden/` contains WSMP-owned canonical adapter
expectations and is versioned independently by `ADAPTER_VERSION`.

Captured/derived 2026-08-24. Refresh deliberately when a supported provider
protocol version changes; conformance tests must review terminal ordering and
required version headers at the same time.
