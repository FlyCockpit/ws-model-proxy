import type { CanonicalEvent, ProtocolSurface } from "./canonical.js";
import { AdapterError, unsupported } from "./errors.js";
import { renderProtocolError } from "./nonstream.js";
import { object, rejectUnknown } from "./parse-utils.js";
import { SseDecoder, type SseRecord } from "./sse.js";

export class CanonicalStreamParser {
  readonly #surface: ProtocolSurface;
  readonly #sse: SseDecoder;
  readonly #signal?: AbortSignal;
  readonly #maxToolArgumentsBytes: number;
  readonly #maxAggregateBytes: number;
  readonly #errorMetadata: {
    status?: number;
    requestId?: string;
    retryAfter?: string;
    retryLimit?: string;
    retryRemaining?: string;
    retryReset?: string;
  };
  readonly #items = new Set<number>();
  readonly #toolBytes = new Map<number, number>();
  readonly #itemIds = new Map<number, string>();
  readonly #synthesizedItemIds = new Set<number>();
  readonly #itemTypes = new Map<number, "text" | "tool_call" | "refusal" | "reasoning">();
  readonly #toolNames = new Map<number, string>();
  readonly #toolArguments = new Map<number, string>();
  readonly #itemText = new Map<number, string>();
  readonly #completedItems = new Set<number>();
  readonly #pendingResponseItems = new Map<
    number,
    { id: string; type: "message" | "function_call" }
  >();
  readonly #responseParts = new Set<number>();
  readonly #completedResponseParts = new Set<number>();
  readonly #completedResponseData = new Set<number>();
  readonly #doneResponseItems = new Map<number, Record<string, unknown>>();
  readonly #canonicalIndexes = new Map<string, number>();
  readonly #maxUnfinishedItems: number;
  #started = false;
  #terminal = false;
  #stopped = false;
  #observable = false;
  #lastSequence = -1;
  #nextResponseOutputIndex = 0;
  #aggregateBytes = 0;
  #pendingChatStop?: ReturnType<typeof stopReason>;
  #chatUsageSeen = false;
  #messageId?: string;
  #messageModel?: string;

  constructor(
    surface: ProtocolSurface,
    options: {
      signal?: AbortSignal;
      maxEventBytes?: number;
      maxToolArgumentsBytes?: number;
      maxUnfinishedItems?: number;
      maxAggregateBytes?: number;
      upstreamStatus?: number;
      requestId?: string;
      retryAfter?: string;
      retryLimit?: string;
      retryRemaining?: string;
      retryReset?: string;
    } = {},
  ) {
    this.#surface = surface;
    this.#signal = options.signal;
    this.#maxToolArgumentsBytes = options.maxToolArgumentsBytes ?? 1024 * 1024;
    this.#maxUnfinishedItems = options.maxUnfinishedItems ?? 64;
    this.#maxAggregateBytes = options.maxAggregateBytes ?? 4 * 1024 * 1024;
    this.#errorMetadata = {
      status: options.upstreamStatus,
      requestId: options.requestId,
      retryAfter: options.retryAfter,
      retryLimit: options.retryLimit,
      retryRemaining: options.retryRemaining,
      retryReset: options.retryReset,
    };
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
    if (this.#signal?.aborted) throw new AdapterError("cancelled", "Stream parsing was cancelled.");
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
    if (output.length > 0) this.#observable = true;
    return output;
  }

  #record(record: SseRecord): CanonicalEvent[] {
    if (this.#terminal)
      throw new AdapterError("event_after_terminal", "Protocol event followed the terminal event.");
    if (record.data === "[DONE]") {
      if (this.#surface !== "openai-chat")
        throw new AdapterError("unexpected_done", "[DONE] is only valid for Chat Completions.");
      if (!this.#pendingChatStop)
        throw new AdapterError("terminal_before_stop", "Chat [DONE] arrived before finish_reason.");
      const completed: CanonicalEvent[] = [];
      for (const index of this.#items)
        if (!this.#completedItems.has(index)) completed.push(...this.#completeItem(index));
      return [...completed, ...this.#stop(this.#pendingChatStop), ...this.#complete()];
    }
    let value: Record<string, unknown>;
    try {
      value = object(JSON.parse(record.data), "stream.data");
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError("invalid_stream_json", "SSE data was not valid JSON.");
    }
    if (this.#surface === "openai-chat") return this.#chat(value);
    const dataType = typeof value.type === "string" ? value.type : "";
    const type = record.event ?? dataType;
    if (!type) throw new AdapterError("missing_event_type", "Stream event type is required.");
    if (record.event && dataType && record.event !== dataType)
      throw new AdapterError("event_type_mismatch", "SSE event and data type do not match.");
    if (this.#surface === "openai-responses") return this.#responses(type, value);
    return this.#anthropic(type, value);
  }

  #start(
    id: unknown,
    model?: unknown,
    usage?: CanonicalEvent & { type: "usage" },
  ): CanonicalEvent[] {
    if (this.#started) throw new AdapterError("duplicate_start", "Stream start was emitted twice.");
    if (typeof id !== "string" || id.length === 0)
      throw new AdapterError("invalid_message_id", "Stream start requires a message ID.");
    this.#started = true;
    this.#messageId = id;
    if (typeof model === "string") this.#messageModel = model;
    return [
      {
        type: "message_start",
        id,
        ...(typeof model === "string" ? { model } : {}),
        ...(usage ? { usage: usage.usage } : {}),
      },
    ];
  }

  #item(index: number, id: string, itemType: "text" | "tool_call" | "refusal" | "reasoning") {
    validIndex(index);
    if (this.#completedItems.has(index))
      throw new AdapterError("event_after_item_complete", `Item ${index} already completed.`);
    if (this.#items.has(index)) return [];
    if (this.#items.size - this.#completedItems.size >= this.#maxUnfinishedItems)
      throw new AdapterError("unfinished_items_exceeded", "Too many unfinished stream items.");
    this.#items.add(index);
    this.#itemIds.set(index, id);
    this.#itemTypes.set(index, itemType);
    return [{ type: "item_start" as const, index, id, itemType }];
  }

  #indexFor(key: string) {
    const existing = this.#canonicalIndexes.get(key);
    if (existing !== undefined) return existing;
    const index = this.#canonicalIndexes.size;
    this.#canonicalIndexes.set(key, index);
    return index;
  }

  #accumulate(value: string) {
    this.#aggregateBytes += new TextEncoder().encode(value).byteLength;
    if (this.#aggregateBytes > this.#maxAggregateBytes)
      throw new AdapterError(
        "stream_aggregate_exceeded",
        "Accumulated stream content exceeded the bounded buffer.",
      );
  }

  #toolDelta(
    index: number,
    id: string,
    name: string | undefined,
    delta: string,
    synthesizedId = false,
  ): CanonicalEvent[] {
    if (this.#items.has(index) && this.#itemTypes.get(index) !== "tool_call")
      throw new AdapterError("item_type_mismatch", `Item ${index} is not a tool call.`);
    if (
      this.#itemIds.has(index) &&
      id !== this.#itemIds.get(index) &&
      !this.#synthesizedItemIds.has(index)
    )
      throw new AdapterError("tool_id_mismatch", `Tool call ${index} changed IDs.`);
    if (name && this.#toolNames.has(index) && name !== this.#toolNames.get(index))
      throw new AdapterError("tool_name_mismatch", `Tool call ${index} changed names.`);
    const stableId = this.#itemIds.get(index) ?? id;
    if (!this.#itemIds.has(index) && synthesizedId) this.#synthesizedItemIds.add(index);
    if (name) this.#toolNames.set(index, name);
    const bytes = (this.#toolBytes.get(index) ?? 0) + new TextEncoder().encode(delta).byteLength;
    if (bytes > this.#maxToolArgumentsBytes)
      throw new AdapterError(
        "tool_arguments_exceeded",
        "Partial tool arguments exceeded the bounded buffer.",
      );
    this.#toolBytes.set(index, bytes);
    this.#accumulate(delta);
    this.#toolArguments.set(index, `${this.#toolArguments.get(index) ?? ""}${delta}`);
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
    if (this.#terminal)
      throw new AdapterError(
        "duplicate_terminal",
        "Protocol stream emitted more than one terminal event.",
      );
    if (!this.#stopped)
      throw new AdapterError("terminal_before_stop", "Terminal event arrived before a stop event.");
    this.#assertItemsComplete();
    this.#terminal = true;
    return [{ type: "complete" }];
  }

  #completeItem(index: number): CanonicalEvent[] {
    validIndex(index);
    if (!this.#items.has(index))
      throw new AdapterError(
        "item_complete_before_start",
        `Item ${index} completed before starting.`,
      );
    if (this.#completedItems.has(index))
      throw new AdapterError("duplicate_item_complete", `Item ${index} completed twice.`);
    if (this.#toolArguments.has(index))
      validateToolJson(this.#toolArguments.get(index) ?? "", index);
    this.#completedItems.add(index);
    return [{ type: "item_complete", index }];
  }

  #stop(reason: ReturnType<typeof stopReason>): CanonicalEvent[] {
    if (this.#stopped)
      throw new AdapterError("duplicate_stop", "Stream emitted more than one stop event.");
    this.#stopped = true;
    return [{ type: "stop", reason }];
  }

  #assertItemsComplete() {
    for (const index of this.#items)
      if (!this.#completedItems.has(index)) {
        // Chat has no item-complete wire event, so its terminal closes all items.
        if (this.#surface === "openai-chat") {
          if (this.#toolArguments.has(index))
            validateToolJson(this.#toolArguments.get(index) ?? "", index);
          this.#completedItems.add(index);
        } else throw new AdapterError("unfinished_item", `Item ${index} did not complete.`);
      }
  }

  #chat(value: Record<string, unknown>): CanonicalEvent[] {
    if (value.error !== undefined) {
      if (this.#stopped || this.#pendingChatStop)
        throw new AdapterError("event_after_stop", "Chat error followed finish_reason.");
      this.#terminal = true;
      return [{ type: "error", error: this.#streamError(value.error) }];
    }
    if (this.#pendingChatStop && Array.isArray(value.choices) && value.choices.length > 0)
      throw new AdapterError("event_after_stop", "Chat candidate event followed finish_reason.");
    rejectUnknown(
      value,
      ["id", "object", "created", "model", "system_fingerprint", "choices", "usage"],
      "stream.data",
    );
    if (!Number.isSafeInteger(value.created) || (value.created as number) < 0)
      throw new AdapterError("invalid_stream_event", "Chat created must be a timestamp integer.");
    if (typeof value.model !== "string" || value.model.length === 0)
      throw new AdapterError("invalid_stream_event", "Chat model is required.");
    const events = this.#started ? [] : this.#start(value.id, value.model);
    if (value.id !== this.#messageId)
      throw new AdapterError("chunk_id_mismatch", "Chat stream changed response IDs.");
    if (this.#messageModel && value.model !== undefined && value.model !== this.#messageModel)
      throw new AdapterError("chunk_model_mismatch", "Chat stream changed models.");
    const choices = value.choices;
    if (!Array.isArray(choices))
      throw new AdapterError("invalid_stream_event", "Chat stream choices must be an array.");
    if (choices.length > 1)
      throw new AdapterError(
        "multiple_candidates",
        "Multiple stream candidates are not adaptable.",
      );
    const observedUsage = usageEvent(value.usage, true);
    if (observedUsage) events.push(observedUsage);
    const choice = choices[0] ? object(choices[0], "choices[0]") : undefined;
    if (!choice) return events;
    if (choice.index !== undefined && choice.index !== 0)
      throw new AdapterError("multiple_candidates", "Only candidate zero is adaptable.");
    rejectUnknown(choice, ["index", "delta", "finish_reason", "logprobs"], "choices[0]");
    if (choice.logprobs != null) unsupported("choices[0].logprobs");
    const delta = object(choice.delta ?? {}, "choices[0].delta");
    rejectUnknown(delta, ["role", "content", "refusal", "tool_calls"], "choices[0].delta");
    if (delta.role !== undefined && delta.role !== "assistant")
      throw new AdapterError("invalid_stream_event", "Stream delta role must be assistant.");
    if (
      typeof delta.content === "string" &&
      delta.content &&
      this.#items.has(this.#indexFor("chat:text")) &&
      this.#itemTypes.get(this.#indexFor("chat:text")) !== "text"
    )
      throw new AdapterError("item_type_mismatch", "Text delta targeted a non-text item.");
    if (typeof delta.content === "string" && delta.content) {
      this.#accumulate(delta.content);
      events.push(...this.#item(this.#indexFor("chat:text"), "text-0", "text"), {
        type: "text_delta",
        index: this.#indexFor("chat:text"),
        delta: delta.content,
      });
    }
    if (
      typeof delta.refusal === "string" &&
      delta.refusal &&
      this.#items.has(this.#indexFor("chat:refusal")) &&
      this.#itemTypes.get(this.#indexFor("chat:refusal")) !== "refusal"
    )
      throw new AdapterError("item_type_mismatch", "Refusal delta targeted a non-refusal item.");
    if (typeof delta.refusal === "string" && delta.refusal) {
      this.#accumulate(delta.refusal);
      events.push(...this.#item(this.#indexFor("chat:refusal"), "refusal-0", "refusal"), {
        type: "refusal_delta",
        index: this.#indexFor("chat:refusal"),
        delta: delta.refusal,
      });
    }
    if (Array.isArray(delta.tool_calls))
      for (const raw of delta.tool_calls) {
        const call = object(raw, "choices[0].delta.tool_calls[]");
        rejectUnknown(call, ["index", "id", "type", "function"], "choices[0].delta.tool_calls[]");
        if (call.type !== undefined && call.type !== "function") unsupported("tool_call.type");
        if (!Number.isSafeInteger(call.index) || (call.index as number) < 0)
          throw new AdapterError(
            "invalid_stream_index",
            "Chat tool call requires a non-negative index.",
          );
        const index = this.#indexFor(`chat:tool:${call.index}`);
        const fn = object(call.function ?? {}, "tool_call.function");
        rejectUnknown(fn, ["name", "arguments"], "tool_call.function");
        events.push(
          ...this.#toolDelta(
            index,
            typeof call.id === "string"
              ? call.id
              : (this.#itemIds.get(index) ?? `generated-call-${index}`),
            typeof fn.name === "string" ? fn.name : undefined,
            typeof fn.arguments === "string" ? fn.arguments : "",
            typeof call.id !== "string" && !this.#itemIds.has(index),
          ),
        );
      }
    if (choice.finish_reason != null) {
      if (this.#pendingChatStop)
        throw new AdapterError("duplicate_stop", "Chat emitted more than one finish_reason.");
      this.#pendingChatStop = stopReason(choice.finish_reason);
    }
    const usage = usageEvent(value.usage, true);
    if (usage) {
      if (this.#chatUsageSeen)
        throw new AdapterError("duplicate_usage", "Chat stream emitted usage twice.");
      this.#chatUsageSeen = true;
      events.push(usage);
    }
    return events;
  }

  #responses(type: string, value: Record<string, unknown>): CanonicalEvent[] {
    const responseEvents = new Set([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.content_part.done",
      "response.output_text.delta",
      "response.output_text.done",
      "response.refusal.delta",
      "response.refusal.done",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
      "response.incomplete",
      "response.failed",
      "error",
    ]);
    if (!responseEvents.has(type))
      throw new AdapterError("unsupported_stream_event", `Unsupported Responses event: ${type}.`);
    rejectUnknown(value, responsesFields(type), "stream.data");
    const sequence = value.sequence_number;
    if (!Number.isSafeInteger(sequence) || sequence !== this.#lastSequence + 1)
      throw new AdapterError(
        "invalid_stream_sequence",
        "Responses sequence_number must be contiguous from zero.",
      );
    this.#lastSequence = sequence as number;
    const response =
      value.response && typeof value.response === "object" ? object(value.response) : value;
    if (
      type === "response.created" ||
      type === "response.in_progress" ||
      type === "response.completed" ||
      type === "response.incomplete" ||
      type === "response.failed"
    )
      rejectUnknown(
        response,
        [
          "id",
          "object",
          "created_at",
          "status",
          "error",
          "incomplete_details",
          "instructions",
          "max_output_tokens",
          "model",
          "output",
          "parallel_tool_calls",
          "previous_response_id",
          "reasoning",
          "store",
          "temperature",
          "text",
          "tool_choice",
          "tools",
          "top_p",
          "truncation",
          "usage",
          "user",
          "metadata",
          "service_tier",
        ],
        "stream.data.response",
      );
    if (
      type === "response.created" ||
      type === "response.in_progress" ||
      type === "response.completed" ||
      type === "response.incomplete" ||
      type === "response.failed"
    )
      validateResponseEnvelope(response);
    const events = type === "response.created" ? this.#start(response.id, response.model) : [];
    if (
      (type === "response.in_progress" ||
        type === "response.completed" ||
        type === "response.incomplete" ||
        type === "response.failed") &&
      response.id !== this.#messageId
    )
      throw new AdapterError("chunk_id_mismatch", "Responses stream changed response IDs.");
    if (
      type !== "error" &&
      this.#messageModel &&
      response.model !== undefined &&
      response.model !== this.#messageModel
    )
      throw new AdapterError("chunk_model_mismatch", "Responses stream changed models.");
    if (type === "response.created") {
      if (
        response.object !== "response" ||
        response.status !== "in_progress" ||
        !Array.isArray(response.output) ||
        response.output.length !== 0
      )
        throw new AdapterError(
          "invalid_response_start",
          "Responses response.created envelope is invalid.",
        );
    }
    if (type === "response.in_progress") {
      if (response.object !== "response" || response.status !== "in_progress")
        throw new AdapterError("invalid_response_state", "Responses in_progress state is invalid.");
      if (!Array.isArray(response.output) || response.output.length !== 0)
        throw new AdapterError(
          "invalid_response_state",
          "Responses in_progress output must be empty.",
        );
    }
    if (!this.#started && type !== "error")
      throw new AdapterError(
        "event_before_start",
        "Responses event arrived before response.created.",
      );
    const needsIndex =
      type.startsWith("response.output_") ||
      type.startsWith("response.function_") ||
      type.startsWith("response.refusal.") ||
      type.startsWith("response.content_part.");
    if (needsIndex && typeof value.output_index !== "number")
      throw new AdapterError("invalid_stream_event", `${type} requires output_index.`);
    const sourceIndex = typeof value.output_index === "number" ? value.output_index : 0;
    validIndex(sourceIndex);
    const index = needsIndex ? this.#indexFor(`responses:${sourceIndex}`) : 0;
    const item = value.item && typeof value.item === "object" ? object(value.item) : {};
    if (type === "response.output_item.added") {
      if (sourceIndex !== this.#nextResponseOutputIndex)
        throw new AdapterError(
          "invalid_stream_index",
          "Responses output_index must be contiguous from zero.",
        );
      this.#nextResponseOutputIndex++;
      rejectUnknown(
        item,
        ["id", "type", "status", "role", "content", "call_id", "name", "arguments"],
        "stream.data.item",
      );
      if (item.type !== "message" && item.type !== "function_call")
        unsupported("stream.data.item.type");
      if (item.status !== "in_progress")
        throw new AdapterError("invalid_item_status", "Responses added item must be in_progress.");
      if (
        item.type === "message" &&
        (item.role !== "assistant" || !Array.isArray(item.content) || item.content.length !== 0)
      )
        throw new AdapterError("invalid_item_start", "Responses message item start is invalid.");
      if (this.#items.has(index))
        throw new AdapterError("duplicate_item_start", `Item ${index} started twice.`);
      if (this.#pendingResponseItems.has(index))
        throw new AdapterError("duplicate_item_start", `Item ${index} started twice.`);
      const id = typeof item.id === "string" ? item.id : `generated-item-${index}`;
      this.#pendingResponseItems.set(index, { id, type: item.type });
      if (item.type === "function_call") {
        if (typeof item.name !== "string" || typeof item.call_id !== "string")
          throw new AdapterError(
            "invalid_stream_event",
            "Function-call start requires name and call_id.",
          );
        if (item.arguments !== "")
          throw new AdapterError("invalid_item_start", "Function-call arguments must start empty.");
        this.#toolNames.set(index, item.name);
        events.push(...this.#item(index, item.call_id, "tool_call"));
      }
    } else if (type === "response.content_part.added") {
      if (value.content_index !== 0)
        throw new AdapterError("multiple_content_parts", "Only content index zero is adaptable.");
      if (this.#responseParts.has(index))
        throw new AdapterError("duplicate_content_part", `Content part ${index}:0 started twice.`);
      const pending = this.#pendingResponseItems.get(index);
      if (pending?.type !== "message")
        throw new AdapterError(
          "content_before_item",
          "Content part arrived before its message item.",
        );
      if (value.item_id !== pending.id)
        throw new AdapterError("item_id_mismatch", `Item ${index} changed IDs.`);
      const part = object(value.part, "stream.data.part");
      rejectUnknown(
        part,
        ["type", "text", "refusal", "annotations", "logprobs"],
        "stream.data.part",
      );
      if (part.type !== "output_text" && part.type !== "refusal")
        unsupported("stream.data.part.type");
      validateEmptyOptionalArray(part.annotations, "stream.data.part.annotations");
      validateEmptyOptionalArray(part.logprobs, "stream.data.part.logprobs");
      this.#responseParts.add(index);
      events.push(...this.#item(index, pending.id, part.type === "refusal" ? "refusal" : "text"));
    } else if (type === "response.content_part.done") {
      if (value.content_index !== 0 || !this.#responseParts.has(index))
        throw new AdapterError(
          "content_part_before_start",
          "Content part completed before starting.",
        );
      if (this.#completedResponseParts.has(index))
        throw new AdapterError("duplicate_content_part_done", "Content part completed twice.");
      if (!this.#completedResponseData.has(index))
        throw new AdapterError(
          "content_done_before_delta_done",
          "Content part completed before its text/refusal done event.",
        );
      const part = object(value.part, "stream.data.part");
      rejectUnknown(
        part,
        ["type", "text", "refusal", "annotations", "logprobs"],
        "stream.data.part",
      );
      const itemType = this.#itemTypes.get(index);
      const field = itemType === "refusal" ? "refusal" : "text";
      if (
        part.type !== (itemType === "refusal" ? "refusal" : "output_text") ||
        part[field] !== (this.#itemText.get(index) ?? "")
      )
        throw new AdapterError("content_mismatch", "Completed content part changed streamed text.");
      validateEmptyOptionalArray(part.annotations, "stream.data.part.annotations");
      validateEmptyOptionalArray(part.logprobs, "stream.data.part.logprobs");
      this.#completedResponseParts.add(index);
    } else if (type === "response.output_text.delta") {
      if (!this.#responseParts.has(index))
        throw new AdapterError(
          "delta_before_content",
          "Text delta arrived before content-part start.",
        );
      if (value.content_index !== 0)
        throw new AdapterError("multiple_content_parts", "Only content index zero is adaptable.");
      if (value.item_id !== this.#pendingResponseItems.get(index)?.id)
        throw new AdapterError("item_id_mismatch", `Item ${index} changed IDs.`);
      validateEmptyOptionalArray(value.logprobs, "stream.data.logprobs");
      if (typeof value.delta !== "string")
        throw new AdapterError("invalid_stream_event", "Text delta must be a string.");
      if (this.#items.has(index) && this.#itemTypes.get(index) !== "text")
        throw new AdapterError("item_type_mismatch", "Text delta targeted a non-text item.");
      events.push(...this.#item(index, `generated-item-${index}`, "text"), {
        type: "text_delta",
        index,
        delta: String(value.delta ?? ""),
      });
      this.#itemText.set(index, `${this.#itemText.get(index) ?? ""}${value.delta}`);
      this.#accumulate(value.delta);
    } else if (type === "response.refusal.delta") {
      if (!this.#responseParts.has(index))
        throw new AdapterError(
          "delta_before_content",
          "Refusal delta arrived before content-part start.",
        );
      if (value.content_index !== 0)
        throw new AdapterError("multiple_content_parts", "Only content index zero is adaptable.");
      if (value.item_id !== this.#pendingResponseItems.get(index)?.id)
        throw new AdapterError("item_id_mismatch", `Item ${index} changed IDs.`);
      if (typeof value.delta !== "string")
        throw new AdapterError("invalid_stream_event", "Refusal delta must be a string.");
      if (this.#items.has(index) && this.#itemTypes.get(index) !== "refusal")
        throw new AdapterError("item_type_mismatch", "Refusal delta targeted a non-refusal item.");
      events.push(...this.#item(index, `generated-refusal-${index}`, "refusal"), {
        type: "refusal_delta",
        index,
        delta: String(value.delta ?? ""),
      });
      this.#itemText.set(index, `${this.#itemText.get(index) ?? ""}${value.delta}`);
      this.#accumulate(value.delta);
    } else if (type === "response.function_call_arguments.delta") {
      if (this.#itemTypes.get(index) !== "tool_call")
        throw new AdapterError(
          "delta_before_item",
          "Tool delta arrived before function-call start.",
        );
      if (typeof value.delta !== "string")
        throw new AdapterError("invalid_stream_event", "Tool delta must be a string.");
      if (
        typeof value.item_id === "string" &&
        this.#pendingResponseItems.get(index)?.id !== value.item_id
      )
        throw new AdapterError("item_id_mismatch", `Item ${index} changed IDs.`);
      events.push(
        ...this.#toolDelta(
          index,
          this.#itemIds.get(index) ?? `generated-call-${index}`,
          undefined,
          String(value.delta ?? ""),
        ),
      );
    } else if (type === "response.output_text.done" || type === "response.refusal.done") {
      if (value.content_index !== 0)
        throw new AdapterError("multiple_content_parts", "Only content index zero is adaptable.");
      if (value.item_id !== this.#pendingResponseItems.get(index)?.id)
        throw new AdapterError("item_id_mismatch", `Item ${index} changed IDs.`);
      validateEmptyOptionalArray(value.logprobs, "stream.data.logprobs");
      const finalText = type === "response.output_text.done" ? value.text : value.refusal;
      if (typeof finalText !== "string" || finalText !== (this.#itemText.get(index) ?? ""))
        throw new AdapterError(
          "content_mismatch",
          "Completed content did not match streamed deltas.",
        );
      if (this.#completedResponseData.has(index))
        throw new AdapterError("duplicate_content_done", "Content completed twice.");
      this.#completedResponseData.add(index);
    } else if (type === "response.function_call_arguments.done") {
      if (value.item_id !== this.#pendingResponseItems.get(index)?.id)
        throw new AdapterError("item_id_mismatch", `Item ${index} changed IDs.`);
      if (
        typeof value.arguments !== "string" ||
        value.arguments !== (this.#toolArguments.get(index) ?? "")
      )
        throw new AdapterError(
          "tool_arguments_mismatch",
          "Completed tool arguments did not match streamed deltas.",
        );
      validateToolJson(value.arguments, index);
      if (this.#completedResponseData.has(index))
        throw new AdapterError("duplicate_tool_done", "Tool arguments completed twice.");
      this.#completedResponseData.add(index);
    } else if (type === "response.output_item.done") {
      rejectUnknown(
        item,
        this.#itemTypes.get(index) === "tool_call"
          ? ["id", "type", "call_id", "name", "arguments", "status"]
          : ["id", "type", "role", "content", "status"],
        "stream.data.item",
      );
      if (typeof item.id === "string" && this.#pendingResponseItems.get(index)?.id !== item.id)
        throw new AdapterError("item_id_mismatch", `Item ${index} changed IDs.`);
      if (this.#itemTypes.get(index) !== "tool_call" && !this.#completedResponseParts.has(index))
        throw new AdapterError(
          "item_before_content_complete",
          "Message item completed before its content part.",
        );
      if (this.#itemTypes.get(index) === "tool_call" && typeof item.arguments === "string") {
        if (!this.#completedResponseData.has(index))
          throw new AdapterError(
            "item_before_tool_complete",
            "Tool item completed before arguments.done.",
          );
        const argumentBytes = new TextEncoder().encode(item.arguments).byteLength;
        if (argumentBytes > this.#maxToolArgumentsBytes)
          throw new AdapterError(
            "tool_arguments_exceeded",
            "Tool arguments exceeded the bounded buffer.",
          );
        if (item.arguments !== (this.#toolArguments.get(index) ?? ""))
          throw new AdapterError(
            "tool_arguments_mismatch",
            "Done tool arguments changed streamed arguments.",
          );
        if (item.call_id !== this.#itemIds.get(index) || item.name !== this.#toolNames.get(index))
          throw new AdapterError(
            "tool_identity_mismatch",
            "Done tool identity changed during streaming.",
          );
      }
      validateResponseDoneItem(item, this.#itemTypes.get(index), this.#itemText.get(index) ?? "");
      this.#doneResponseItems.set(sourceIndex, item);
      events.push(...this.#completeItem(index));
    } else if (type === "response.completed" || type === "response.incomplete") {
      if (
        response.object !== "response" ||
        response.status !== (type === "response.incomplete" ? "incomplete" : "completed")
      )
        throw new AdapterError("invalid_terminal_status", "Responses terminal status is invalid.");
      if (
        type === "response.incomplete" &&
        object(response.incomplete_details, "response.incomplete_details").reason !==
          "max_output_tokens"
      )
        throw new AdapterError(
          "unsupported_stop_reason",
          "Responses incomplete reason is not safely adaptable.",
        );
      if (!Array.isArray(response.output))
        throw new AdapterError(
          "invalid_terminal_output",
          "Responses terminal output must be an array.",
        );
      const expected = [...this.#doneResponseItems.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, done]) => done);
      if (JSON.stringify(response.output) !== JSON.stringify(expected))
        throw new AdapterError(
          "terminal_output_mismatch",
          "Responses terminal output did not match completed items.",
        );
      const usage = usageEvent(response.usage, true);
      if (usage) events.push(usage);
      events.push(
        ...this.#stop(stopReason(type === "response.incomplete" ? "length" : "stop")),
        ...this.#complete(),
      );
    } else if (type === "response.failed" || type === "error") {
      if (this.#stopped)
        throw new AdapterError("event_after_stop", "Responses error followed the stop barrier.");
      if (
        type === "response.failed" &&
        (response.object !== "response" || response.status !== "failed" || !response.error)
      )
        throw new AdapterError("invalid_failed_response", "Responses failed state requires error.");
      this.#terminal = true;
      events.push({
        type: "error",
        error: this.#streamError(
          type === "error"
            ? {
                code: value.code,
                message: value.message,
                param: value.param,
              }
            : response.error,
        ),
      });
    }
    return events;
  }

  #anthropic(type: string, value: Record<string, unknown>): CanonicalEvent[] {
    const anthropicEvents = new Set([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
      "ping",
      "error",
    ]);
    if (!anthropicEvents.has(type))
      throw new AdapterError("unsupported_stream_event", `Unsupported Anthropic event: ${type}.`);
    if (this.#stopped && type !== "message_stop")
      throw new AdapterError("event_after_stop", "Anthropic event followed the stop barrier.");
    rejectUnknown(value, anthropicFields(type), "stream.data");
    const message = value.message && typeof value.message === "object" ? object(value.message) : {};
    if (type === "message_start")
      rejectUnknown(
        message,
        ["id", "type", "role", "content", "model", "stop_reason", "stop_sequence", "usage"],
        "stream.data.message",
      );
    if (type === "message_start") {
      if (
        message.type !== "message" ||
        message.role !== "assistant" ||
        !Array.isArray(message.content) ||
        message.content.length !== 0 ||
        message.stop_reason !== null ||
        message.stop_sequence !== null
      )
        throw new AdapterError(
          "invalid_message_start",
          "Anthropic message_start envelope is invalid.",
        );
    }
    const initialUsage = type === "message_start" ? usageEvent(message.usage) : undefined;
    if (type === "message_start" && initialUsage?.usage.inputTokens === undefined)
      throw new AdapterError("invalid_usage", "Anthropic message_start requires input_tokens.");
    const events =
      type === "message_start" ? this.#start(message.id, message.model, initialUsage) : [];
    if (!this.#started && type !== "error" && type !== "ping")
      throw new AdapterError("event_before_start", "Anthropic event arrived before message_start.");
    const blockEvent = type.startsWith("content_block_");
    const sourceIndex = typeof value.index === "number" ? value.index : 0;
    if (blockEvent && typeof value.index !== "number")
      throw new AdapterError("invalid_stream_event", `${type} requires index.`);
    if (blockEvent) validIndex(sourceIndex);
    const index = blockEvent ? this.#indexFor(`anthropic:${sourceIndex}`) : 0;
    if (type === "content_block_start") {
      const block = object(value.content_block, "content_block");
      rejectUnknown(block, ["type", "id", "name", "input", "text"], "content_block");
      if (block.type !== "text" && block.type !== "tool_use") unsupported("content_block.type");
      if (block.type === "text" && block.text !== "")
        throw new AdapterError("invalid_block_start", "Anthropic text block must start empty.");
      if (
        block.type === "tool_use" &&
        (typeof block.id !== "string" ||
          typeof block.name !== "string" ||
          !block.input ||
          typeof block.input !== "object" ||
          Array.isArray(block.input) ||
          Object.keys(block.input as Record<string, unknown>).length !== 0)
      )
        throw new AdapterError(
          "invalid_tool_start",
          "Anthropic tool_use must start with id, name, and empty input.",
        );
      if (this.#items.has(index))
        throw new AdapterError("duplicate_item_start", `Item ${index} started twice.`);
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
      rejectUnknown(delta, ["type", "text", "partial_json"], "delta");
      if (delta.type === "text_delta")
        if (this.#items.has(index) && this.#itemTypes.get(index) !== "text")
          throw new AdapterError("item_type_mismatch", "Text delta targeted a non-text item.");
      if (delta.type === "text_delta")
        if (typeof delta.text !== "string")
          throw new AdapterError("invalid_stream_event", "Anthropic text delta must be a string.");
      if (delta.type === "text_delta") {
        this.#accumulate(delta.text as string);
        events.push(...this.#item(index, `generated-block-${index}`, "text"), {
          type: "text_delta",
          index,
          delta: String(delta.text ?? ""),
        });
      } else if (delta.type === "input_json_delta") {
        if (typeof delta.partial_json !== "string")
          throw new AdapterError(
            "invalid_stream_event",
            "Anthropic partial_json must be a string.",
          );
        events.push(
          ...this.#toolDelta(
            index,
            this.#itemIds.get(index) ?? `generated-block-${index}`,
            this.#toolNames.get(index),
            delta.partial_json,
          ),
        );
      } else unsupported("stream.delta.type");
    } else if (type === "content_block_stop") events.push(...this.#completeItem(index));
    else if (type === "message_delta") {
      const delta = object(value.delta ?? {}, "delta");
      rejectUnknown(delta, ["stop_reason", "stop_sequence"], "delta");
      if (delta.stop_sequence !== null && delta.stop_sequence !== undefined)
        throw new AdapterError(
          "unsupported_stop_sequence",
          "Anthropic stop_sequence detail is not safely adaptable.",
        );
      const usage = usageEvent(value.usage);
      if (usage) events.push(usage);
      if (delta.stop_reason != null) events.push(...this.#stop(stopReason(delta.stop_reason)));
    } else if (type === "message_stop") events.push(...this.#complete());
    else if (type === "ping") return events;
    else if (type === "error") {
      this.#terminal = true;
      events.push({
        type: "error",
        error: this.#streamError(
          value.error,
          typeof value.request_id === "string" ? value.request_id : undefined,
        ),
      });
    }
    return events;
  }

  #streamError(value: unknown, eventRequestId?: string) {
    const error = object(value, "stream.error");
    rejectUnknown(error, ["code", "type", "message", "param"], "stream.error");
    return {
      code:
        typeof error.code === "string"
          ? error.code
          : typeof error.type === "string"
            ? error.type
            : "upstream_error",
      message: safeMessage(error),
      ...(typeof error.param === "string" ? { parameter: error.param } : {}),
      ...(this.#errorMetadata.status ? { upstreamStatus: this.#errorMetadata.status } : {}),
      ...(eventRequestId || this.#errorMetadata.requestId
        ? { requestId: eventRequestId ?? this.#errorMetadata.requestId }
        : {}),
      ...(this.#errorMetadata.retryAfter ? { retryAfter: this.#errorMetadata.retryAfter } : {}),
      ...(this.#errorMetadata.retryLimit ? { retryLimit: this.#errorMetadata.retryLimit } : {}),
      ...(this.#errorMetadata.retryRemaining
        ? { retryRemaining: this.#errorMetadata.retryRemaining }
        : {}),
      ...(this.#errorMetadata.retryReset ? { retryReset: this.#errorMetadata.retryReset } : {}),
    };
  }
}

function usageEvent(
  value: unknown,
  requireBoth = false,
): Extract<CanonicalEvent, { type: "usage" }> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = object(value);
  rejectUnknown(
    usage,
    [
      "input_tokens",
      "output_tokens",
      "prompt_tokens",
      "completion_tokens",
      "total_tokens",
      "input_tokens_details",
      "output_tokens_details",
      "prompt_tokens_details",
      "completion_tokens_details",
    ],
    "stream.usage",
  );
  const input = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;
  if (
    (input !== undefined && (!Number.isSafeInteger(input) || (input as number) < 0)) ||
    (output !== undefined && (!Number.isSafeInteger(output) || (output as number) < 0))
  )
    throw new AdapterError("invalid_usage", "Stream usage tokens must be non-negative integers.");
  if (
    (requireBoth && (input === undefined || output === undefined)) ||
    (!requireBoth && input === undefined && output === undefined)
  )
    throw new AdapterError("invalid_usage", "Stream usage is missing required token counts.");
  const total = usage.total_tokens;
  if (
    total !== undefined &&
    (!Number.isSafeInteger(total) ||
      input === undefined ||
      output === undefined ||
      total !== (input as number) + (output as number))
  )
    throw new AdapterError("invalid_usage", "Stream total_tokens must equal input plus output.");
  return {
    type: "usage",
    usage: {
      ...(typeof input === "number" ? { inputTokens: input } : {}),
      ...(typeof output === "number" ? { outputTokens: output } : {}),
    },
  };
}

function validateResponseEnvelope(response: Record<string, unknown>) {
  if (!Number.isSafeInteger(response.created_at) || (response.created_at as number) < 0)
    throw new AdapterError("invalid_response_envelope", "Responses created_at is required.");
  if (typeof response.model !== "string" || response.model.length === 0)
    throw new AdapterError("invalid_response_envelope", "Responses model is required.");
  if (!new Set(["in_progress", "completed", "incomplete", "failed"]).has(String(response.status)))
    throw new AdapterError("invalid_response_state", "Responses status is unsupported.");
  for (const key of [
    "error",
    "incomplete_details",
    "instructions",
    "max_output_tokens",
    "parallel_tool_calls",
    "previous_response_id",
    "reasoning",
    "store",
    "temperature",
    "text",
    "tool_choice",
    "tools",
    "top_p",
    "truncation",
    "metadata",
    "usage",
  ])
    if (!(key in response))
      throw new AdapterError("invalid_response_envelope", `Responses envelope is missing ${key}.`);
  const emptyObject = (value: unknown) =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0;
  if (
    response.instructions !== null ||
    response.max_output_tokens !== null ||
    response.parallel_tool_calls !== false ||
    response.previous_response_id !== null ||
    response.store !== false ||
    response.temperature !== null ||
    response.tool_choice !== "none" ||
    !Array.isArray(response.tools) ||
    response.tools.length !== 0 ||
    response.top_p !== null ||
    response.truncation !== "disabled" ||
    !emptyObject(response.metadata)
  )
    throw new AdapterError(
      "unsupported_response_configuration",
      "Responses envelope contains unsupported mutable configuration.",
    );
  if (response.user !== undefined && response.user !== null)
    unsupported("response.user", "is not safely adaptable");
  if (
    response.service_tier !== undefined &&
    response.service_tier !== null &&
    response.service_tier !== "default"
  )
    unsupported("response.service_tier", "is not safely adaptable");
  const reasoning = object(response.reasoning, "response.reasoning");
  rejectUnknown(reasoning, ["effort", "summary"], "response.reasoning");
  if (reasoning.effort !== null || reasoning.summary !== null)
    unsupported("response.reasoning", "is not safely adaptable");
  const text = object(response.text, "response.text");
  rejectUnknown(text, ["format"], "response.text");
  const format = object(text.format, "response.text.format");
  rejectUnknown(format, ["type"], "response.text.format");
  if (format.type !== "text") unsupported("response.text.format.type");
  if (
    (response.status === "in_progress" &&
      (response.error !== null ||
        response.incomplete_details !== null ||
        response.usage !== null)) ||
    (response.status === "completed" &&
      (response.error !== null || response.incomplete_details !== null)) ||
    (response.status === "incomplete" &&
      (response.error !== null || response.incomplete_details == null)) ||
    (response.status === "failed" && response.error == null)
  )
    throw new AdapterError(
      "invalid_response_state",
      "Responses status does not match error, incomplete, or usage state.",
    );
  if (response.error !== null) {
    const error = object(response.error, "response.error");
    rejectUnknown(error, ["code", "message", "type", "param"], "response.error");
    if (typeof error.code !== "string" || typeof error.message !== "string")
      throw new AdapterError(
        "invalid_response_error",
        "Responses error requires code and message strings.",
      );
    if (error.type !== undefined && typeof error.type !== "string")
      throw new AdapterError("invalid_response_error", "Responses error.type must be text.");
    if (error.param !== undefined && error.param !== null && typeof error.param !== "string")
      throw new AdapterError(
        "invalid_response_error",
        "Responses error.param must be text or null.",
      );
  }
  if (response.incomplete_details !== null) {
    const details = object(response.incomplete_details, "response.incomplete_details");
    rejectUnknown(details, ["reason"], "response.incomplete_details");
    if (details.reason !== "max_output_tokens") unsupported("response.incomplete_details.reason");
  }
  if (response.usage !== null && response.usage !== undefined) usageEvent(response.usage, true);
  if (
    response.status === "failed" &&
    (!Array.isArray(response.output) ||
      response.output.length !== 0 ||
      response.incomplete_details !== null ||
      response.usage !== null)
  )
    throw new AdapterError(
      "invalid_failed_response",
      "Failed Responses envelopes require empty output and null incomplete/usage fields.",
    );
}

function validateCanonicalUsage(usage: { inputTokens?: number; outputTokens?: number }) {
  if (
    !Number.isSafeInteger(usage.inputTokens) ||
    !Number.isSafeInteger(usage.outputTokens) ||
    (usage.inputTokens as number) < 0 ||
    (usage.outputTokens as number) < 0 ||
    !Number.isSafeInteger((usage.inputTokens as number) + (usage.outputTokens as number))
  )
    throw new AdapterError(
      "invalid_usage",
      "Canonical usage requires complete non-negative safe integer token counts.",
    );
}

function validIndex(index: number) {
  if (!Number.isSafeInteger(index) || index < 0)
    throw new AdapterError(
      "invalid_stream_index",
      "Stream item index must be a non-negative integer.",
    );
}

function validateToolJson(value: string, index: number) {
  try {
    object(JSON.parse(value), `tool_call[${index}].arguments`);
  } catch {
    throw new AdapterError(
      "incomplete_tool_arguments",
      `Tool arguments for item ${index} were not a complete JSON object.`,
    );
  }
}

function validateResponseDoneItem(
  item: Record<string, unknown>,
  type: "text" | "tool_call" | "refusal" | "reasoning" | undefined,
  accumulatedText: string,
) {
  if (item.status !== "completed")
    throw new AdapterError("invalid_done_status", "Responses done item must be completed.");
  if (type === "tool_call") {
    if (
      item.type !== "function_call" ||
      typeof item.id !== "string" ||
      typeof item.call_id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.arguments !== "string"
    )
      throw new AdapterError("invalid_done_item", "Responses done tool item is incomplete.");
    return;
  }
  if (item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content))
    throw new AdapterError("invalid_done_item", "Responses done message item is incomplete.");
  if (item.content.length !== 1)
    throw new AdapterError(
      "multiple_content_parts",
      "Only one completed content part is adaptable.",
    );
  const content = object(item.content[0], "stream.data.item.content[0]");
  rejectUnknown(
    content,
    ["type", "text", "refusal", "annotations", "logprobs"],
    "stream.data.item.content[0]",
  );
  const field = type === "refusal" ? "refusal" : "text";
  const expectedType = type === "refusal" ? "refusal" : "output_text";
  if (content.type !== expectedType || content[field] !== accumulatedText)
    throw new AdapterError(
      "done_content_mismatch",
      "Responses done content changed streamed text.",
    );
  for (const arrayField of ["annotations", "logprobs"] as const) {
    if (content[arrayField] !== undefined) {
      if (!Array.isArray(content[arrayField]))
        throw new AdapterError("invalid_done_item", `${arrayField} must be an array.`);
      if (content[arrayField].length) unsupported(`stream.data.item.content[0].${arrayField}`);
    }
  }
}

function validateEmptyOptionalArray(value: unknown, parameter: string) {
  if (value === undefined) return;
  if (!Array.isArray(value))
    throw new AdapterError("invalid_stream_event", `${parameter} must be an array.`);
  if (value.length) unsupported(parameter);
}

function responsesFields(type: string): readonly string[] {
  if (type === "error") return ["type", "code", "message", "param", "sequence_number"];
  if (type === "response.output_item.added" || type === "response.output_item.done")
    return ["type", "output_index", "item", "sequence_number"];
  if (type === "response.content_part.added" || type === "response.content_part.done")
    return ["type", "output_index", "content_index", "item_id", "part", "sequence_number"];
  if (type === "response.output_text.delta" || type === "response.refusal.delta")
    return [
      "type",
      "output_index",
      "content_index",
      "item_id",
      "delta",
      "logprobs",
      "sequence_number",
    ];
  if (type === "response.output_text.done")
    return [
      "type",
      "output_index",
      "content_index",
      "item_id",
      "text",
      "logprobs",
      "sequence_number",
    ];
  if (type === "response.refusal.done")
    return ["type", "output_index", "content_index", "item_id", "refusal", "sequence_number"];
  if (type === "response.function_call_arguments.delta")
    return ["type", "output_index", "item_id", "delta", "sequence_number"];
  if (type === "response.function_call_arguments.done")
    return ["type", "output_index", "item_id", "arguments", "sequence_number"];
  return ["type", "response", "sequence_number"];
}

function anthropicFields(type: string): readonly string[] {
  if (type === "message_start") return ["type", "message"];
  if (type === "content_block_start") return ["type", "index", "content_block"];
  if (type === "content_block_delta") return ["type", "index", "delta"];
  if (type === "content_block_stop") return ["type", "index"];
  if (type === "message_delta") return ["type", "delta", "usage"];
  if (type === "error") return ["type", "error", "request_id"];
  return ["type"];
}

function stopReason(value: unknown): "stop" | "length" | "tool" | "content_filter" | "unknown" {
  if (value === "stop" || value === "stop_sequence" || value === "end_turn") return "stop";
  if (value === "length" || value === "max_tokens") return "length";
  if (value === "tool_calls" || value === "tool_use") return "tool";
  if (value === "content_filter") return "content_filter";
  throw new AdapterError("unsupported_stop_reason", `Unsupported stop reason: ${String(value)}.`);
}

function safeMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message.slice(0, 1000);
  }
  return "Upstream protocol error.";
}

type WirePayload =
  | Record<string, unknown>
  | { event: string; data: Record<string, unknown> }
  | "[DONE]";

/** Stateful canonical-to-wire renderer. It rejects sequences that cannot form a valid protocol stream. */
export class CanonicalStreamRenderer {
  readonly #surface: ProtocolSurface;
  readonly #signal?: AbortSignal;
  readonly #items = new Map<number, CanonicalEvent & { type: "item_start" }>();
  readonly #wireStarted = new Set<number>();
  readonly #parts = new Set<number>();
  readonly #completed = new Set<number>();
  readonly #toolArguments = new Map<number, string>();
  readonly #toolNames = new Map<number, string>();
  readonly #itemText = new Map<number, string>();
  readonly #chatToolIndexes = new Map<number, number>();
  readonly #wireIndexes = new Map<number, number>();
  readonly #responseOutput = new Map<number, Record<string, unknown>>();
  readonly #maxAggregateBytes: number;
  #messageId = "adapted";
  #model?: string;
  #started = false;
  #stopped = false;
  #stopEvent?: CanonicalEvent & { type: "stop" };
  #usageEvent?: CanonicalEvent & { type: "usage" };
  #terminal = false;
  #responseSequence = 0;
  #aggregateBytes = 0;

  constructor(
    surface: ProtocolSurface,
    options: { signal?: AbortSignal; maxAggregateBytes?: number } = {},
  ) {
    this.#surface = surface;
    this.#signal = options.signal;
    this.#maxAggregateBytes = options.maxAggregateBytes ?? 4 * 1024 * 1024;
  }

  push(event: CanonicalEvent): Uint8Array[] {
    this.#checkCancellation();
    if (this.#terminal)
      throw new AdapterError(
        "event_after_terminal",
        "Canonical event followed the terminal event.",
      );
    this.#validate(event);
    return this.#payloads(event).map(encodePayload);
  }

  finish() {
    this.#checkCancellation();
    if (!this.#terminal)
      throw new AdapterError(
        "truncated_stream",
        "Canonical stream ended before its terminal event.",
      );
  }

  #checkCancellation() {
    if (this.#signal?.aborted)
      throw new AdapterError("cancelled", "Stream rendering was cancelled.");
  }

  #wireIndex(index: number) {
    const existing = this.#wireIndexes.get(index);
    if (existing !== undefined) return existing;
    const target = this.#wireIndexes.size;
    this.#wireIndexes.set(index, target);
    return target;
  }

  #responseEvent(event: string, fields: Record<string, unknown>): WirePayload {
    return {
      event,
      data: { type: event, sequence_number: this.#responseSequence++, ...fields },
    };
  }

  #validate(event: CanonicalEvent) {
    if (event.type === "message_start") {
      if (this.#started)
        throw new AdapterError("duplicate_start", "Canonical stream started twice.");
      if (typeof event.model !== "string" || event.model.length === 0)
        throw new AdapterError(
          "missing_model",
          `${this.#surface} stream rendering requires a non-empty model.`,
        );
      this.#started = true;
      this.#messageId = event.id;
      this.#model = event.model;
      if (event.usage) validateCanonicalUsage(event.usage);
      return;
    }
    if (event.type === "error") {
      if (this.#stopped)
        throw new AdapterError("event_after_stop", "Canonical error followed the stop barrier.");
      this.#terminal = true;
      return;
    }
    if (!this.#started)
      throw new AdapterError("event_before_start", "Canonical event arrived before message_start.");
    if (this.#stopped && event.type !== "complete")
      throw new AdapterError("event_after_stop", "Canonical event followed the stop barrier.");
    if (event.type === "item_start") {
      validIndex(event.index);
      if (this.#items.has(event.index))
        throw new AdapterError("duplicate_item_start", `Item ${event.index} started twice.`);
      this.#items.set(event.index, event);
      if (event.itemType === "tool_call")
        this.#chatToolIndexes.set(event.index, this.#chatToolIndexes.size);
    } else if ("index" in event) {
      validIndex(event.index);
      const item = this.#items.get(event.index);
      if (!item)
        throw new AdapterError(
          "item_event_before_start",
          `Item ${event.index} event arrived before its start.`,
        );
      if (this.#completed.has(event.index))
        throw new AdapterError(
          "event_after_item_complete",
          `Item ${event.index} already completed.`,
        );
      if (event.type === "text_delta" && item.itemType !== "text")
        throw new AdapterError("item_type_mismatch", "Text delta targeted a non-text item.");
      if (event.type === "refusal_delta" && item.itemType !== "refusal")
        throw new AdapterError("item_type_mismatch", "Refusal delta targeted a non-refusal item.");
      if (event.type === "reasoning_delta" && item.itemType !== "reasoning")
        throw new AdapterError(
          "item_type_mismatch",
          "Reasoning delta targeted a non-reasoning item.",
        );
      if (event.type === "tool_arguments_delta" && item.itemType !== "tool_call")
        throw new AdapterError("item_type_mismatch", "Tool delta targeted a non-tool item.");
      if (event.type === "tool_arguments_delta")
        this.#toolArguments.set(
          event.index,
          `${this.#toolArguments.get(event.index) ?? ""}${event.delta}`,
        );
      if (event.type === "tool_arguments_delta" && event.name)
        this.#toolNames.set(event.index, event.name);
      if (event.type === "text_delta" || event.type === "refusal_delta")
        this.#itemText.set(event.index, `${this.#itemText.get(event.index) ?? ""}${event.delta}`);
      if (
        event.type === "tool_arguments_delta" ||
        event.type === "text_delta" ||
        event.type === "refusal_delta" ||
        event.type === "reasoning_delta"
      ) {
        this.#aggregateBytes += new TextEncoder().encode(event.delta).byteLength;
        if (this.#aggregateBytes > this.#maxAggregateBytes)
          throw new AdapterError(
            "stream_aggregate_exceeded",
            "Accumulated rendered content exceeded the bounded buffer.",
          );
      }
      if (event.type === "item_complete") {
        if (item.itemType === "tool_call")
          validateToolJson(this.#toolArguments.get(event.index) ?? "", event.index);
        this.#completed.add(event.index);
      }
    } else if (event.type === "stop") {
      if (this.#stopped)
        throw new AdapterError("duplicate_stop", "Canonical stream stopped twice.");
      if (
        event.reason === "unknown" ||
        (event.reason === "content_filter" && this.#surface !== "openai-chat")
      )
        throw new AdapterError(
          "unsupported_stop_reason",
          `${event.reason} is not safely representable on ${this.#surface}.`,
        );
      this.#stopped = true;
      this.#stopEvent = event;
    } else if (event.type === "usage") {
      if (this.#usageEvent)
        throw new AdapterError("duplicate_usage", "Canonical stream emitted usage twice.");
      validateCanonicalUsage(event.usage);
      this.#usageEvent = event;
    } else if (event.type === "complete") {
      if (!this.#stopped)
        throw new AdapterError("terminal_before_stop", "Canonical completion arrived before stop.");
      for (const index of this.#items.keys())
        if (!this.#completed.has(index))
          throw new AdapterError("unfinished_item", `Item ${index} did not complete.`);
      this.#terminal = true;
    }
  }

  #payloads(event: CanonicalEvent): WirePayload[] {
    if (this.#surface === "openai-chat") return this.#chat(event);
    if (this.#surface === "openai-responses") return this.#responses(event);
    return this.#anthropic(event);
  }

  #chat(event: CanonicalEvent): WirePayload[] {
    if (event.type === "error") return [renderProtocolError("openai-chat", event.error)];
    if (!this.#model)
      throw new AdapterError("missing_model", "Chat stream rendering requires a model.");
    const base = {
      id: this.#messageId,
      object: "chat.completion.chunk",
      created: 0,
      model: this.#model,
    };
    if (event.type === "message_start")
      return [
        { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      ];
    if (event.type === "text_delta")
      return [
        { ...base, choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }] },
      ];
    if (event.type === "refusal_delta")
      return [
        { ...base, choices: [{ index: 0, delta: { refusal: event.delta }, finish_reason: null }] },
      ];
    if (event.type === "tool_arguments_delta")
      return [
        {
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: this.#chatToolIndexes.get(event.index) ?? 0,
                    id: event.id,
                    type: "function",
                    function: {
                      ...(event.name ? { name: event.name } : {}),
                      arguments: event.delta,
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
      ];
    if (event.type === "usage")
      return [
        {
          ...base,
          choices: [],
          usage: {
            prompt_tokens: event.usage.inputTokens,
            completion_tokens: event.usage.outputTokens,
            total_tokens: (event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0),
          },
        },
      ];
    if (event.type === "stop")
      return [
        {
          ...base,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: event.reason === "tool" ? "tool_calls" : event.reason,
            },
          ],
        },
      ];
    if (event.type === "complete") return ["[DONE]"];
    if (event.type === "reasoning_delta")
      throw new AdapterError(
        "unsupported_stream_event",
        "Chat Completions cannot render reasoning deltas.",
      );
    return [];
  }

  #responses(event: CanonicalEvent): WirePayload[] {
    if (event.type === "message_start")
      return [
        this.#responseEvent("response.created", {
          response: {
            id: event.id,
            object: "response",
            created_at: 0,
            status: "in_progress",
            error: null,
            incomplete_details: null,
            instructions: null,
            max_output_tokens: null,
            model: event.model,
            output: [],
            parallel_tool_calls: false,
            previous_response_id: null,
            reasoning: { effort: null, summary: null },
            store: false,
            temperature: null,
            text: { format: { type: "text" } },
            tool_choice: "none",
            tools: [],
            top_p: null,
            truncation: "disabled",
            usage: null,
            metadata: {},
          },
        }),
      ];
    if (event.type === "item_start") {
      if (event.itemType === "tool_call") return [];
      this.#wireStarted.add(event.index);
      const outputIndex = this.#wireIndex(event.index);
      return [
        this.#responseEvent("response.output_item.added", {
          output_index: outputIndex,
          item: {
            id: event.id,
            type: "message",
            status: "in_progress",
            role: "assistant",
            content: [],
          },
        }),
      ];
    }
    if (event.type === "tool_arguments_delta") {
      const output: WirePayload[] = [];
      const outputIndex = this.#wireIndex(event.index);
      if (!this.#wireStarted.has(event.index)) {
        if (!event.name)
          throw new AdapterError("missing_tool_name", "First tool delta must include its name.");
        this.#wireStarted.add(event.index);
        output.push(
          this.#responseEvent("response.output_item.added", {
            output_index: outputIndex,
            item: {
              id: event.id,
              type: "function_call",
              status: "in_progress",
              call_id: event.id,
              name: event.name,
              arguments: "",
            },
          }),
        );
      }
      output.push(
        this.#responseEvent("response.function_call_arguments.delta", {
          output_index: outputIndex,
          item_id: event.id,
          delta: event.delta,
        }),
      );
      return output;
    }
    if (event.type === "text_delta" || event.type === "refusal_delta") {
      const output: WirePayload[] = [];
      const outputIndex = this.#wireIndex(event.index);
      const kind = event.type === "text_delta" ? "output_text" : "refusal";
      if (!this.#parts.has(event.index)) {
        this.#parts.add(event.index);
        output.push(
          this.#responseEvent("response.content_part.added", {
            output_index: outputIndex,
            content_index: 0,
            item_id: this.#items.get(event.index)?.id,
            part: {
              type: kind,
              [event.type === "text_delta" ? "text" : "refusal"]: "",
              annotations: [],
            },
          }),
        );
      }
      output.push(
        this.#responseEvent(
          event.type === "text_delta" ? "response.output_text.delta" : "response.refusal.delta",
          {
            output_index: outputIndex,
            content_index: 0,
            item_id: this.#items.get(event.index)?.id,
            delta: event.delta,
          },
        ),
      );
      return output;
    }
    if (event.type === "item_complete") {
      const item = this.#items.get(event.index);
      const output: WirePayload[] = [];
      const outputIndex = this.#wireIndex(event.index);
      if (item?.itemType === "tool_call")
        output.push(
          this.#responseEvent("response.function_call_arguments.done", {
            output_index: outputIndex,
            item_id: item.id,
            arguments: this.#toolArguments.get(event.index) ?? "",
          }),
        );
      if (item?.itemType !== "tool_call" && !this.#parts.has(event.index)) {
        this.#parts.add(event.index);
        output.push(
          this.#responseEvent("response.content_part.added", {
            output_index: outputIndex,
            content_index: 0,
            item_id: item?.id,
            part:
              item?.itemType === "refusal"
                ? { type: "refusal", refusal: "" }
                : { type: "output_text", text: "", annotations: [], logprobs: [] },
          }),
        );
      }
      if (this.#parts.has(event.index)) {
        output.push(
          this.#responseEvent(
            item?.itemType === "refusal" ? "response.refusal.done" : "response.output_text.done",
            {
              output_index: outputIndex,
              content_index: 0,
              item_id: item?.id,
              [item?.itemType === "refusal" ? "refusal" : "text"]:
                this.#itemText.get(event.index) ?? "",
              ...(item?.itemType === "text" ? { logprobs: [] } : {}),
            },
          ),
        );
        output.push(
          this.#responseEvent("response.content_part.done", {
            output_index: outputIndex,
            content_index: 0,
            item_id: item?.id,
            part:
              item?.itemType === "refusal"
                ? { type: "refusal", refusal: this.#itemText.get(event.index) ?? "" }
                : {
                    type: "output_text",
                    text: this.#itemText.get(event.index) ?? "",
                    annotations: [],
                  },
          }),
        );
      }
      const doneItem: Record<string, unknown> = {
        id: item?.id,
        type: item?.itemType === "tool_call" ? "function_call" : "message",
        status: "completed",
        ...(item?.itemType === "tool_call"
          ? {
              call_id: item.id,
              name: this.#toolNames.get(event.index),
              arguments: this.#toolArguments.get(event.index) ?? "",
            }
          : {
              role: "assistant",
              content: [
                item?.itemType === "refusal"
                  ? { type: "refusal", refusal: this.#itemText.get(event.index) ?? "" }
                  : {
                      type: "output_text",
                      text: this.#itemText.get(event.index) ?? "",
                      annotations: [],
                    },
              ],
            }),
      };
      this.#responseOutput.set(outputIndex, doneItem);
      output.push(
        this.#responseEvent("response.output_item.done", {
          output_index: outputIndex,
          item: doneItem,
        }),
      );
      return output;
    }
    if (event.type === "complete")
      return [
        this.#responseEvent(
          this.#stopEvent?.reason === "length" ? "response.incomplete" : "response.completed",
          {
            response: {
              id: this.#messageId,
              object: "response",
              created_at: 0,
              status: this.#stopEvent?.reason === "length" ? "incomplete" : "completed",
              error: null,
              model: this.#model,
              output: [...this.#responseOutput.entries()]
                .sort(([left], [right]) => left - right)
                .map(([, item]) => item),
              ...(this.#stopEvent?.reason === "length"
                ? { incomplete_details: { reason: "max_output_tokens" } }
                : { incomplete_details: null }),
              instructions: null,
              max_output_tokens: null,
              parallel_tool_calls: false,
              previous_response_id: null,
              reasoning: { effort: null, summary: null },
              store: false,
              temperature: null,
              text: { format: { type: "text" } },
              tool_choice: "none",
              tools: [],
              top_p: null,
              truncation: "disabled",
              metadata: {},
              usage: null,
              ...(this.#usageEvent
                ? {
                    usage: {
                      input_tokens: this.#usageEvent.usage.inputTokens,
                      output_tokens: this.#usageEvent.usage.outputTokens,
                      total_tokens:
                        (this.#usageEvent.usage.inputTokens ?? 0) +
                        (this.#usageEvent.usage.outputTokens ?? 0),
                    },
                  }
                : {}),
            },
          },
        ),
      ];
    if (event.type === "error")
      return [
        {
          event: "error",
          data: {
            type: "error",
            sequence_number: this.#responseSequence++,
            code: event.error.code,
            message: event.error.message,
            param: event.error.parameter ?? null,
          },
        },
      ];
    if (event.type === "reasoning_delta")
      throw new AdapterError(
        "unsupported_stream_event",
        "Responses reasoning rendering is outside the safe subset.",
      );
    return [];
  }

  #anthropic(event: CanonicalEvent): WirePayload[] {
    if (event.type === "message_start") {
      if (event.usage?.inputTokens === undefined || event.usage.outputTokens === undefined)
        throw new AdapterError(
          "unsupported_stream_adaptation",
          "Anthropic streaming requires initial usage; sources that report usage only at completion are unavailable.",
        );
      return [
        named("message_start", {
          message: {
            id: event.id,
            type: "message",
            role: "assistant",
            content: [],
            model: event.model,
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: event.usage.inputTokens,
              output_tokens: event.usage.outputTokens,
            },
          },
        }),
      ];
    }
    if (event.type === "item_start") {
      if (event.itemType === "tool_call") return [];
      if (event.itemType !== "text")
        throw new AdapterError(
          "unsupported_stream_event",
          `Anthropic cannot render ${event.itemType} items.`,
        );
      this.#wireStarted.add(event.index);
      const blockIndex = this.#wireIndex(event.index);
      return [
        named("content_block_start", {
          index: blockIndex,
          content_block: { type: "text", text: "" },
        }),
      ];
    }
    if (event.type === "tool_arguments_delta") {
      const output: WirePayload[] = [];
      const blockIndex = this.#wireIndex(event.index);
      if (!this.#wireStarted.has(event.index)) {
        if (!event.name)
          throw new AdapterError("missing_tool_name", "First tool delta must include its name.");
        this.#wireStarted.add(event.index);
        output.push(
          named("content_block_start", {
            index: blockIndex,
            content_block: { type: "tool_use", id: event.id, name: event.name, input: {} },
          }),
        );
      }
      output.push(
        named("content_block_delta", {
          index: blockIndex,
          delta: { type: "input_json_delta", partial_json: event.delta },
        }),
      );
      return output;
    }
    if (event.type === "text_delta")
      return [
        named("content_block_delta", {
          index: this.#wireIndex(event.index),
          delta: { type: "text_delta", text: event.delta },
        }),
      ];
    if (event.type === "item_complete")
      return [named("content_block_stop", { index: this.#wireIndex(event.index) })];
    if (event.type === "usage") return [];
    if (event.type === "stop")
      return [
        named("message_delta", {
          delta: { stop_reason: anthropicStopReason(event.reason), stop_sequence: null },
          usage: { output_tokens: this.#usageEvent?.usage.outputTokens ?? 0 },
        }),
      ];
    if (event.type === "complete") return [named("message_stop", {})];
    if (event.type === "error")
      return [{ event: "error", data: renderProtocolError("anthropic-messages", event.error) }];
    throw new AdapterError("unsupported_stream_event", `Anthropic cannot render ${event.type}.`);
  }
}

export function createCanonicalSseTransform(
  surface: ProtocolSurface,
  options: {
    signal?: AbortSignal;
    highWaterMarkBytes?: number;
    maxChunkBytes?: number;
    maxAggregateBytes?: number;
  } = {},
): TransformStream<CanonicalEvent, Uint8Array> {
  const renderer = new CanonicalStreamRenderer(surface, options);
  const highWaterMark = options.highWaterMarkBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(highWaterMark) || highWaterMark <= 0)
    throw new AdapterError(
      "invalid_buffer_limit",
      "highWaterMarkBytes must be a positive integer.",
    );
  const maxChunkBytes = options.maxChunkBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes <= 0)
    throw new AdapterError("invalid_buffer_limit", "maxChunkBytes must be a positive integer.");
  let abortListener: (() => void) | undefined;
  const removeAbortListener = () => {
    if (abortListener) options.signal?.removeEventListener("abort", abortListener);
    abortListener = undefined;
  };
  return new TransformStream<CanonicalEvent, Uint8Array>(
    {
      start(controller) {
        abortListener = () =>
          controller.error(new AdapterError("cancelled", "Stream rendering was cancelled."));
        if (options.signal?.aborted) abortListener();
        else options.signal?.addEventListener("abort", abortListener, { once: true });
      },
      transform(event, controller) {
        try {
          for (const chunk of renderer.push(event)) {
            if (chunk.byteLength > maxChunkBytes)
              throw new AdapterError(
                "stream_chunk_exceeded",
                "Rendered SSE event exceeded the bounded buffer.",
              );
            controller.enqueue(chunk);
          }
        } catch (error) {
          removeAbortListener();
          throw error;
        }
      },
      flush() {
        try {
          renderer.finish();
        } finally {
          removeAbortListener();
        }
      },
    },
    undefined,
    { highWaterMark, size: (chunk) => chunk.byteLength },
  );
}

function named(event: string, fields: Record<string, unknown>): WirePayload {
  return { event, data: { type: event, ...fields } };
}

function encodePayload(payload: WirePayload): Uint8Array {
  return new TextEncoder().encode(
    payload === "[DONE]"
      ? "data: [DONE]\n\n"
      : `${"event" in payload ? `event: ${payload.event}\n` : ""}data: ${JSON.stringify("data" in payload ? payload.data : payload)}\n\n`,
  );
}

function anthropicStopReason(reason: "stop" | "length" | "tool" | "content_filter" | "unknown") {
  if (reason === "length") return "max_tokens";
  if (reason === "tool") return "tool_use";
  return "end_turn";
}
