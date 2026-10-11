/**
 * Small protocol extractors for the Test page: the visible answer and the reasoning (thinking)
 * transcript of each request API, streamed or whole. They never alter visible content (for
 * example, they do not split `<think>` tags).
 */
export type TestTranscript = { content: string; thinking: string };

const EMPTY: TestTranscript = { content: "", thinking: "" };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** One OpenAI Chat Completions stream chunk. */
export function completionDeltas(value: unknown): TestTranscript {
  const root = record(value);
  if (!root || !Array.isArray(root.choices)) return EMPTY;
  return root.choices.reduce<TestTranscript>(
    (result, choice) => {
      const choiceRecord = record(choice);
      const delta = choiceRecord ? record(choiceRecord.delta) : null;
      if (delta) {
        result.content += text(delta.content);
        result.thinking += text(delta.reasoning_content) || text(delta.reasoning);
      } else if (choiceRecord) {
        result.content += text(choiceRecord.text);
      }
      return result;
    },
    { content: "", thinking: "" },
  );
}

/** One OpenAI Responses stream event (`response.output_text.delta`, reasoning deltas). */
export function responsesEventDeltas(type: string, value: unknown): TestTranscript {
  const event = record(value);
  if (!event) return EMPTY;
  if (type === "response.output_text.delta") return { content: text(event.delta), thinking: "" };
  if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta")
    return { content: "", thinking: text(event.delta) };
  return EMPTY;
}

/** One Anthropic Messages stream event (`content_block_delta` text and thinking). */
export function anthropicEventDeltas(type: string, value: unknown): TestTranscript {
  if (type !== "content_block_delta") return EMPTY;
  const delta = record(record(value)?.delta);
  if (!delta) return EMPTY;
  if (delta.type === "text_delta") return { content: text(delta.text), thinking: "" };
  if (delta.type === "thinking_delta") return { content: "", thinking: text(delta.thinking) };
  return EMPTY;
}

/** Output tokens a stream reports, by API; undefined when the event carries none. */
export function streamedOutputTokens(type: string, value: unknown): number | undefined {
  const root = record(value);
  if (!root) return undefined;
  const usage =
    type === "response.completed"
      ? record(record(root.response)?.usage)
      : type === "message_delta"
        ? record(root.usage)
        : record(root.usage);
  const tokens = usage?.completion_tokens ?? usage?.output_tokens;
  return typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? tokens : undefined;
}

/** The error message of a stream `error` / `response.failed` event, if it is one. */
export function streamErrorMessage(type: string, value: unknown): string | null {
  const root = record(value);
  if (!root) return null;
  if (type === "error" || (type === "" && root.error !== undefined)) {
    const error = record(root.error);
    return text(error?.message) || text(root.message) || "error";
  }
  if (type === "response.failed") {
    const error = record(record(root.response)?.error);
    return text(error?.message) || "response.failed";
  }
  return null;
}
