# Local runtime tool routing: October 2026 field report

This report condenses the [October 2026 troubleshooting gist](https://gist.github.com/speedysebi/f2afba24688d8f4065aec65e8bb92bdc) into a reproducible account for WSMP maintainers. The original gist retains the longer machine logs, GPU test scripts, response files, and setup chronology. These observations concern a 0.4.0 deployment; the deployed server's exact Git commit was not independently verified. The source analysis used `865ba31398e9ad151a20e9b249b4811b50e50f3f`.

## User-visible failure

An Ubuntu node running CLI 0.4.0, connected with Full control, served local models through always-on OpenAI-compatible runtimes. Plain and streaming Chat Completions worked through a pool. A request with a single function tool returned HTTP 400 `unsupported_capability` before reaching the local server. Disabling pool protocol adaptation did not change the result. The selected model did support function calls when called directly.

The initial 0.4.0 handoff was a fresh setup: the 0.3 and 0.4 data models and relay protocols are incompatible, so the node was enrolled again and its runtime, pool, API key, and agent token were recreated. Early troubleshooting checked two plausible configuration causes: whether the runtime declared an OpenAI-compatible Chat endpoint and whether the client addressed a **pool** instead of the raw model. Those settings were corrected or confirmed before the minimal tool request below was repeated. The [0.4.0 upgrade notes](../release-notes/0.4.0.md) document the release migration separately.

Two upstreams reproduced the same proxy failure:

| Upstream | WSMP behavior | Direct upstream behavior |
| --- | --- | --- |
| Ollama with Hermes 4.3 36B GGUF | Plain and streaming chat succeeded; a request with one function tool and `parallel_tool_calls: false` returned `unsupported_capability`. A request log showed zero attempts, no selected node or instance, and no upstream error. | Returned a function tool call. Ollama advertised tools, thinking, and completion for the model. |
| llama.cpp b11609 with Qwen3.8 27B GGUF on the R9700 | After correcting the always-on model declaration, plain chat returned HTTP 200. The same pool rejected a tool request with HTTP 400. | Returned HTTP 200 with a `connection_check` tool call and `{"message":"ok"}` arguments. |

The Qwen direct test used the same function schema and explicit tool choice, but different model addressing and direct template arguments. The Hermes request log is evidence for that request, not a fresh trace of every Qwen request. Both results support a proxy-side routing failure; neither proves that every local model supports tools.

An earlier Qwen setup error was separate: the runtime still declared the preset model `local-gguf`, so the actual Qwen served model had no effective text-generation capability and even plain chat failed. Correcting the declared upstream model ID, coarse capabilities, and pool membership restored plain chat. It did not fix tool-bearing requests.

## Minimal reproduction

Use an API key scoped to a local pool whose upstream accepts OpenAI Chat Completions tools. Set `WSMP_BASE_URL` to the deployment's base URL, including `/v1`, and replace `OWNER/POOL` below with the pool's callable ID. Keep the key out of shell history and shared files.

```sh
curl "$WSMP_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $WSMP_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @- <<'JSON'
{
  "model": "OWNER/POOL",
  "messages": [{"role": "user", "content": "Call connection_check with message ok."}],
  "max_tokens": 128,
  "tools": [{
    "type": "function",
    "function": {
      "name": "connection_check",
      "description": "Check the connection.",
      "parameters": {
        "type": "object",
        "properties": {"message": {"type": "string"}},
        "required": ["message"]
      }
    }
  }],
  "tool_choice": {"type": "function", "function": {"name": "connection_check"}},
  "parallel_tool_calls": false
}
JSON
```

The observed pre-fix response was HTTP 400 with `error.code` set to `unsupported_capability` and the message “The selected model does not support this endpoint.” A direct request to the local inference server returned a tool call. A tool-disabled OpenCode diagnostic agent could chat through WSMP, while its normal build agent failed when it sent tools.

## Cause in the 0.4.0 code

1. The CLI's always-on inventory in `apps/cli/src/runtimes/inventory.rs` passes discovered model IDs to `always_on_entry`. `apps/cli/src/runtimes/endpoints.rs` builds coarse capabilities from declarations or model-type defaults.
2. `RuntimeModel` in `packages/db/prisma/schema/runtimes.prisma` stores coarse `ModelCapability` arrays. The enum includes `TEXT_GENERATION`, media and embeddings flags, and `RESPONSES_API`, but no tool flag or per-surface metadata. `apps/server/src/runtimes/always-on.ts` persists those coarse values.
3. `apps/server/src/model-api/served-model-capabilities.ts` calls `openAiCapabilitiesFromCoarse`. For `TEXT_GENERATION`, `packages/api/src/lib/openai-compatible-capabilities.ts` reconstructs a legacy native Chat surface with `supported` and `streaming`, but no `tools` or `parallelTools` value.
4. `apps/server/src/model-api/request-feature-profiler.ts` marks nonempty tools as required. It also marks parallel tools when `parallel_tool_calls` is omitted under its current rules; explicitly setting it to `false` still leaves `tools: true`.
5. Pool routing in `apps/server/src/model-api/routes.ts` resolves the execution path for each member. `packages/api/src/lib/surface-capabilities.ts` originally rejected a requested feature unless its value was exactly `true`. Because `undefined !== true`, a coarse local Chat model was filtered out before relay. With no eligible member, the pool returned `unsupported_capability` and recorded zero upstream attempts.

Coarse capability overrides, a Full-control node trust level, and turning off protocol adaptation cannot supply a missing tool flag. The MCP server version suffix `+tools.185cd824a5d6` is a tool-manifest hash, not a Git commit or proof of a custom deployment.

## Compatibility policy in this PR

When surface metadata leaves `tools`, `parallelTools`, `structuredOutput`, or `reasoning` unknown, the resolver now lets native requests reach the upstream. An explicit `false` still rejects. The same policy lets function tools pass through adapted routes when `parallelTools` is not requested; hosted tools remain gated, and `adaptedSubsetFailures` still rejects reasoning, structured output, parallel tool calls, and other extensions outside the adapter's common subset. Media, streaming, context limits, protocol versions, and beta features remain strict.

This applies to the surface resolver generally, including provider inventories and local runtimes; it is not specific to local runtime members. A longer-term path is to discover or declare per-model, per-surface capabilities and persist them through `RuntimeModel` so unknown support can become known over time.

Resolver tests cover unknown features on native Chat, Responses, and Anthropic surfaces; function tools through Chat adaptation; strict adapted-subset features; explicit `false`; and hosted-tool/media gates. Pool route tests send a function-tool request through the real route and relay executor to a fake connected node, check the forwarded JSON body, return a tool-call completion, and send a tool result in the follow-up request. They do not contact a deployed node or model server.

## Validation after deployment

1. Confirm the deployed server includes this PR and the node is connected. Verify the pool ID refers to the served model, not its raw upstream model ID.
2. Repeat plain and streaming chat. Repeat the single-tool request above with `parallel_tool_calls: false`, then one where that field is omitted. Confirm the request reaches the local upstream and returns a tool call or a meaningful upstream error.
3. Test a streamed tool call and a follow-up message containing the tool result.
4. Select the pool as OpenCode's primary model and complete a small real coding task that uses tools. A plain prompt or a tool-disabled agent only verifies text generation.
5. Check that a model with explicit tool refusal remains ineligible and that native tool passthrough did not make adapted routes eligible.

No live deployment or post-deployment tool-call validation had been performed when this report was updated.
