import type { SurfaceRequestRequirements } from "@ws-model-proxy/api/lib/surface-capabilities";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function normalizedType(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function markMediaType(type: string | undefined, requirements: SurfaceRequestRequirements) {
  if (!type) return;
  if (type === "image" || type === "image_url" || type === "input_image")
    requirements.inputImages = true;
  if (
    type === "audio" ||
    type === "audio_url" ||
    type === "input_audio" ||
    type === "input_audio_buffer"
  )
    requirements.inputAudio = true;
  if (type === "video" || type === "video_url" || type === "input_video")
    requirements.inputVideo = true;
}

function visitInput(value: unknown, requirements: SurfaceRequestRequirements): void {
  if (Array.isArray(value)) {
    for (const item of value) visitInput(item, requirements);
    return;
  }
  const item = object(value);
  if (!item) return;
  markMediaType(normalizedType(item.type), requirements);
  for (const key of ["content", "input", "messages"] as const) {
    if (key in item) visitInput(item[key], requirements);
  }
}

function profileTools(value: unknown, requirements: SurfaceRequestRequirements) {
  if (!Array.isArray(value) || value.length === 0) return;
  requirements.tools = true;
  for (const tool of value) {
    const type = normalizedType(object(tool)?.type);
    // Function/custom tools execute in the caller. Every other named tool type
    // is provider-hosted (web/file search, computer use, code interpreter, etc.).
    if (type && type !== "function" && type !== "custom") {
      requirements.hostedTools = true;
      return;
    }
  }
}

function structuredOutputRequested(payload: JsonObject): boolean {
  const responseFormat = object(payload.response_format);
  const responseFormatType = normalizedType(responseFormat?.type);
  if (responseFormatType && responseFormatType !== "text") return true;

  const textFormat = object(object(payload.text)?.format);
  const textFormatType = normalizedType(textFormat?.type);
  if (textFormatType && textFormatType !== "text") return true;

  const outputFormat = object(object(payload.output_config)?.format);
  return outputFormat !== undefined;
}

function reasoningRequested(payload: JsonObject): boolean {
  if (payload.reasoning_effort !== undefined && payload.reasoning_effort !== null) return true;
  const reasoning = object(payload.reasoning);
  if (
    reasoning &&
    Object.values(reasoning).some(
      (value) => value !== undefined && value !== null && value !== false,
    )
  )
    return true;
  if (payload.reasoning !== undefined && payload.reasoning !== null && !reasoning) return true;
  const thinking = object(payload.thinking);
  if (!thinking) return payload.thinking !== undefined && payload.thinking !== null;
  return normalizedType(thinking.type) !== "disabled";
}

/**
 * Conservatively profiles raw generation payloads for capability routing.
 * This deliberately does not validate or canonicalize the request: native
 * provider extensions must still filter pool candidates before dispatch.
 */
export function profileSurfaceRequest(payload: JsonObject): SurfaceRequestRequirements {
  const requirements: SurfaceRequestRequirements = {};

  visitInput(payload.messages, requirements);
  visitInput(payload.input, requirements);
  profileTools(payload.tools, requirements);

  if (
    requirements.tools &&
    (payload.parallel_tool_calls === true ||
      (payload.parallel_tool_calls === undefined &&
        object(payload.tool_choice)?.disable_parallel_tool_use !== true) ||
      object(payload.tool_choice)?.disable_parallel_tool_use === false)
  )
    requirements.parallelTools = true;
  if (structuredOutputRequested(payload)) requirements.structuredOutput = true;
  if (reasoningRequested(payload)) requirements.reasoning = true;

  const modalities = Array.isArray(payload.modalities) ? payload.modalities : [];
  for (const modality of modalities) {
    const type = normalizedType(modality);
    if (type === "image") requirements.outputImages = true;
    if (type === "audio") requirements.outputAudio = true;
    if (type === "video") requirements.outputVideo = true;
  }
  if (payload.audio !== undefined) requirements.outputAudio = true;

  return requirements;
}
