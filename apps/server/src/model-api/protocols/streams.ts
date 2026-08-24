import type { CanonicalEvent, ProtocolSurface } from "./canonical.js";
import { AdapterError, unsupported } from "./errors.js";
import { object } from "./parse-utils.js";
import { SseDecoder, type SseRecord } from "./sse.js";

export class CanonicalStreamParser {
  readonly #surface: ProtocolSurface;
  readonly #sse: SseDecoder;
  readonly #signal?: AbortSignal;
  readonly #maxToolArgumentsBytes: number;
  readonly #items = new Set<number>();
  readonly #toolBytes = new Map<number, number>();
  readonly #itemIds = new Map<number, string>();
  readonly #toolNames = new Map<number, string>();
  #started = false;
  #terminal = false;
  #observable = false;

  constructor(
    surface: ProtocolSurface,
    options: { signal?: AbortSignal; maxEventBytes?: number; maxToolArgumentsBytes?: number } = {},
  ) {
    this.#surface = surface;
    this.#signal = options.signal;
    this.#maxToolArgumentsBytes = options.maxToolArgumentsBytes ?? 1024 * 1024;
    this.#sse = new SseDecoder({ maxBufferBytes: options.maxEventBytes });
  }

  get observableOutput() {
    return this.#observable;
  }
  get retrySafe() {
    return !this.#observable;
  }

  push(chunk: Uint8Array): CanonicalEvent[] {
    if (this.#signal?.aborted) throw new AdapterError("cancelled", "Stream parsing was cancelled.");
    return this.#records(this.#sse.push(chunk));
  }

  finish(): CanonicalEvent[] {
    const events = this.#records(this.#sse.finish());
    if (!this.#terminal)
      throw new AdapterError(
        "truncated_stream",
        "Protocol stream ended before its terminal event.",
      );
    return events;
  }

  #records(records: SseRecord[]): CanonicalEvent[] {
    const output = records.flatMap((record) => this.#record(record));
    if (output.some((event) => event.type !== "message_start" && event.type !== "usage"))
      this.#observable = true;
    return output;
  }

  #record(record: SseRecord): CanonicalEvent[] {
    if (this.#terminal)
      throw new AdapterError("event_after_terminal", "Protocol event followed the terminal event.");
    if (record.data === "[DONE]") return this.#complete();
    let value: Record<string, unknown>;
    try {
      value = object(JSON.parse(record.data), "stream.data");
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError("invalid_stream_json", "SSE data was not valid JSON.");
    }
    if (this.#surface === "openai-chat") return this.#chat(value);
    if (this.#surface === "openai-responses")
      return this.#responses(record.event ?? String(value.type ?? ""), value);
    return this.#anthropic(record.event ?? String(value.type ?? ""), value);
  }

  #start(id: unknown, model?: unknown): CanonicalEvent[] {
    if (this.#started) return [];
    this.#started = true;
    return [
      {
        type: "message_start",
        id: typeof id === "string" ? id : "generated-message-0",
        ...(typeof model === "string" ? { model } : {}),
      },
    ];
  }

  #item(index: number, id: string, itemType: "text" | "tool_call" | "refusal" | "reasoning") {
    if (this.#items.has(index)) return [];
    this.#items.add(index);
    this.#itemIds.set(index, id);
    return [{ type: "item_start" as const, index, id, itemType }];
  }

  #toolDelta(index: number, id: string, name: string | undefined, delta: string): CanonicalEvent[] {
    const stableId = this.#itemIds.get(index) ?? id;
    if (name) this.#toolNames.set(index, name);
    const bytes = (this.#toolBytes.get(index) ?? 0) + new TextEncoder().encode(delta).byteLength;
    if (bytes > this.#maxToolArgumentsBytes)
      throw new AdapterError(
        "tool_arguments_exceeded",
        "Partial tool arguments exceeded the bounded buffer.",
      );
    this.#toolBytes.set(index, bytes);
    return [
      ...this.#item(index, stableId, "tool_call"),
      {
        type: "tool_arguments_delta",
        index,
        id: stableId,
        ...(this.#toolNames.get(index) ? { name: this.#toolNames.get(index) } : {}),
        delta,
      },
    ];
  }

  #complete(): CanonicalEvent[] {
    if (!this.#started)
      throw new AdapterError(
        "terminal_before_start",
        "Terminal event arrived before stream start.",
      );
    this.#terminal = true;
    return [{ type: "complete" }];
  }

  #chat(value: Record<string, unknown>): CanonicalEvent[] {
    const events = this.#start(value.id, value.model);
    const choices = value.choices;
    if (!Array.isArray(choices)) {
      const usage = usageEvent(value.usage);
      return usage ? [...events, usage] : events;
    }
    if (choices.length > 1)
      throw new AdapterError(
        "multiple_candidates",
        "Multiple stream candidates are not adaptable.",
      );
    const choice = choices[0] ? object(choices[0], "choices[0]") : undefined;
    if (!choice) return events;
    if (choice.index !== undefined && choice.index !== 0)
      throw new AdapterError("multiple_candidates", "Only candidate zero is adaptable.");
    const delta = object(choice.delta ?? {}, "choices[0].delta");
    if (typeof delta.content === "string" && delta.content)
      events.push(...this.#item(0, "text-0", "text"), {
        type: "text_delta",
        index: 0,
        delta: delta.content,
      });
    if (typeof delta.refusal === "string" && delta.refusal)
      events.push(...this.#item(1, "refusal-0", "refusal"), {
        type: "refusal_delta",
        index: 1,
        delta: delta.refusal,
      });
    if (Array.isArray(delta.tool_calls))
      for (const raw of delta.tool_calls) {
        const call = object(raw, "choices[0].delta.tool_calls[]");
        const index = typeof call.index === "number" ? call.index + 10 : 10;
        const fn = object(call.function ?? {}, "tool_call.function");
        events.push(
          ...this.#toolDelta(
            index,
            typeof call.id === "string" ? call.id : `generated-call-${index}`,
            typeof fn.name === "string" ? fn.name : undefined,
            typeof fn.arguments === "string" ? fn.arguments : "",
          ),
        );
      }
    if (choice.finish_reason != null)
      events.push({ type: "stop", reason: stopReason(choice.finish_reason) });
    const usage = usageEvent(value.usage);
    if (usage) events.push(usage);
    return events;
  }

  #responses(type: string, value: Record<string, unknown>): CanonicalEvent[] {
    const response =
      value.response && typeof value.response === "object" ? object(value.response) : value;
    const events =
      type === "response.created" || type === "response.in_progress"
        ? this.#start(response.id, response.model)
        : [];
    if (!this.#started && type !== "error")
      throw new AdapterError(
        "event_before_start",
        "Responses event arrived before response.created.",
      );
    const index = typeof value.output_index === "number" ? value.output_index : 0;
    const item = value.item && typeof value.item === "object" ? object(value.item) : {};
    if (type === "response.output_item.added")
      events.push(
        ...this.#item(
          index,
          typeof item.id === "string" ? item.id : `generated-item-${index}`,
          item.type === "function_call" ? "tool_call" : "text",
        ),
      );
    else if (type === "response.output_text.delta")
      events.push(...this.#item(index, `generated-item-${index}`, "text"), {
        type: "text_delta",
        index,
        delta: String(value.delta ?? ""),
      });
    else if (type === "response.refusal.delta")
      events.push(...this.#item(index, `generated-refusal-${index}`, "refusal"), {
        type: "refusal_delta",
        index,
        delta: String(value.delta ?? ""),
      });
    else if (type === "response.function_call_arguments.delta")
      events.push(
        ...this.#toolDelta(
          index,
          String(value.item_id ?? `generated-call-${index}`),
          undefined,
          String(value.delta ?? ""),
        ),
      );
    else if (type === "response.output_item.done") events.push({ type: "item_complete", index });
    else if (type === "response.completed") {
      const usage = usageEvent(response.usage);
      if (usage) events.push(usage);
      events.push({ type: "stop", reason: "stop" }, ...this.#complete());
    } else if (type === "response.failed" || type === "error") {
      this.#terminal = true;
      events.push({
        type: "error",
        error: { code: "upstream_error", message: safeMessage(value.error ?? response.error) },
      });
    }
    return events;
  }

  #anthropic(type: string, value: Record<string, unknown>): CanonicalEvent[] {
    const message = value.message && typeof value.message === "object" ? object(value.message) : {};
    const events = type === "message_start" ? this.#start(message.id, message.model) : [];
    if (!this.#started && type !== "error")
      throw new AdapterError("event_before_start", "Anthropic event arrived before message_start.");
    const index = typeof value.index === "number" ? value.index : 0;
    if (type === "content_block_start") {
      const block = object(value.content_block, "content_block");
      if (block.type === "tool_use" && typeof block.name === "string")
        this.#toolNames.set(index, block.name);
      events.push(
        ...this.#item(
          index,
          typeof block.id === "string" ? block.id : `generated-block-${index}`,
          block.type === "tool_use" ? "tool_call" : "text",
        ),
      );
    } else if (type === "content_block_delta") {
      const delta = object(value.delta, "delta");
      if (delta.type === "text_delta")
        events.push(...this.#item(index, `generated-block-${index}`, "text"), {
          type: "text_delta",
          index,
          delta: String(delta.text ?? ""),
        });
      else if (delta.type === "input_json_delta")
        events.push(
          ...this.#toolDelta(
            index,
            this.#itemIds.get(index) ?? `generated-block-${index}`,
            this.#toolNames.get(index),
            String(delta.partial_json ?? ""),
          ),
        );
      else unsupported("stream.delta.type");
    } else if (type === "content_block_stop") events.push({ type: "item_complete", index });
    else if (type === "message_delta") {
      const delta = object(value.delta ?? {}, "delta");
      const usage = usageEvent(value.usage);
      if (usage) events.push(usage);
      if (delta.stop_reason != null)
        events.push({ type: "stop", reason: stopReason(delta.stop_reason) });
    } else if (type === "message_stop") events.push(...this.#complete());
    else if (type === "error") {
      this.#terminal = true;
      events.push({
        type: "error",
        error: { code: "upstream_error", message: safeMessage(value.error) },
      });
    }
    return events;
  }
}

function usageEvent(value: unknown): CanonicalEvent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = object(value);
  const input = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;
  return {
    type: "usage",
    usage: {
      ...(typeof input === "number" ? { inputTokens: input } : {}),
      ...(typeof output === "number" ? { outputTokens: output } : {}),
    },
  };
}

function stopReason(value: unknown): "stop" | "length" | "tool" | "content_filter" | "unknown" {
  if (value === "stop" || value === "stop_sequence" || value === "end_turn") return "stop";
  if (value === "length" || value === "max_tokens") return "length";
  if (value === "tool_calls" || value === "tool_use") return "tool";
  if (value === "content_filter") return "content_filter";
  return "unknown";
}

function safeMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message.slice(0, 1000);
  }
  return "Upstream protocol error.";
}

export function renderCanonicalSse(surface: ProtocolSurface, event: CanonicalEvent): Uint8Array {
  const payload =
    surface === "anthropic-messages"
      ? anthropicPayload(event)
      : surface === "openai-responses"
        ? responsesPayload(event)
        : chatPayload(event);
  return new TextEncoder().encode(
    payload === "[DONE]"
      ? "data: [DONE]\n\n"
      : `${"event" in payload ? `event: ${payload.event}\n` : ""}data: ${JSON.stringify("data" in payload ? payload.data : payload)}\n\n`,
  );
}

function chatPayload(event: CanonicalEvent): Record<string, unknown> | "[DONE]" {
  if (event.type === "complete") return "[DONE]";
  if (event.type === "text_delta")
    return {
      id: "adapted",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }],
    };
  if (event.type === "stop")
    return {
      id: "adapted",
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: event.reason === "tool" ? "tool_calls" : event.reason,
        },
      ],
    };
  if (event.type === "usage")
    return {
      id: "adapted",
      object: "chat.completion.chunk",
      choices: [],
      usage: {
        prompt_tokens: event.usage.inputTokens,
        completion_tokens: event.usage.outputTokens,
      },
    };
  return { id: "adapted", object: "chat.completion.chunk", choices: [] };
}

function responsesPayload(event: CanonicalEvent): { event: string; data: Record<string, unknown> } {
  if (event.type === "message_start")
    return {
      event: "response.created",
      data: { type: "response.created", response: { id: event.id, status: "in_progress" } },
    };
  if (event.type === "text_delta")
    return {
      event: "response.output_text.delta",
      data: { type: "response.output_text.delta", output_index: event.index, delta: event.delta },
    };
  if (event.type === "complete")
    return {
      event: "response.completed",
      data: { type: "response.completed", response: { id: "adapted", status: "completed" } },
    };
  if (event.type === "error")
    return { event: "error", data: { type: "error", error: event.error } };
  return { event: `response.${event.type}`, data: { ...event, type: `response.${event.type}` } };
}

function anthropicPayload(event: CanonicalEvent): { event: string; data: Record<string, unknown> } {
  if (event.type === "message_start")
    return {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: event.id,
          type: "message",
          role: "assistant",
          content: [],
          model: event.model,
          stop_reason: null,
          usage: {},
        },
      },
    };
  if (event.type === "text_delta")
    return {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: event.index,
        delta: { type: "text_delta", text: event.delta },
      },
    };
  if (event.type === "complete") return { event: "message_stop", data: { type: "message_stop" } };
  if (event.type === "error")
    return { event: "error", data: { type: "error", error: event.error } };
  return { event: event.type, data: { ...event } };
}
