# Lab transformer runbook

Point a pool transformer at a Halo-style media agent (or any OpenAI-compatible VLM).

## Checklist

1. Publish the transformer as a normal `wsmp` endpoint.
2. In the dashboard, set that model's **Images** (and audio/video if needed) checkboxes. Probe never infers multimodality from the model id.
3. Enable `expandMedia` on local llama.cpp/VLM endpoints that cannot fetch remote URLs.
4. On the pool: pick the transformer, enable the modalities you want transformed, leave **fail closed** (no silent text-only fallback).
5. Optional: enable **Forward primary tool names and descriptions** so the agent can choose OmniParser / diarization / etc. Only names and descriptions are sent.
6. The transformer hop is always non-streaming. Chat Test shows the injected `<wmp_media_transform>` body, latency, and cache result.

## Probe and inventory

A successful probe **accumulates** newly discovered models and refreshes suggestions. It does not remove models. Use `wsmp endpoints probe --apply --replace` to prune unpinned models missing from `/v1/models`. Pin a model in CLI config (`pinned: true`) to keep it across `--replace`. Failed probes do not change the catalog.

Dashboard capability edits are server-authoritative (`capabilityOverrideOrigin=DASHBOARD`). A connected CLI copies those values into local config on the next `hello` / `wsmp reload`. CLI-authored overrides remain editable via config until the dashboard touches that model.

## Debugging

- Chat Test: open **What the primary saw** under the assistant reply.
- Errors from the transformer hop are prefixed with `Transformer error:` and include the upstream status/body snippet.
- Pool member **Test member** sends a short ping and resets health on success.
