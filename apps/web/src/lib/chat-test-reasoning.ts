/** Small protocol extractors for Chat Test. They deliberately do not alter
 * visible content (for example, they do not split `<think>` tags). */
export type ChatTestTranscript = { content: string; thinking: string };

/** Reject a successful response that rendered neither user-visible text nor a
 * thinking transcript.  Keeping this shared makes streaming and non-streaming
 * Chat Test paths obey the same successful-response contract. */
export function requireChatTestOutput(
  transcript: ChatTestTranscript,
  fallbackErrorMessage: string,
): ChatTestTranscript {
  if (!transcript.content && !transcript.thinking) throw new Error(fallbackErrorMessage);
  return transcript;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function completionDeltas(value: unknown): ChatTestTranscript {
  const root = record(value);
  if (!root || !Array.isArray(root.choices)) return { content: "", thinking: "" };
  return root.choices.reduce<ChatTestTranscript>(
    (result, choice) => {
      const choiceRecord = record(choice);
      const delta = choiceRecord ? record(choiceRecord.delta) : null;
      if (delta) {
        if ("content" in delta && typeof delta.content === "string") {
          result.content += delta.content;
        }
        if (typeof delta.reasoning_content === "string") result.thinking += delta.reasoning_content;
        else if (typeof delta.reasoning === "string") result.thinking += delta.reasoning;
      }
      if (
        (!delta || !("content" in delta)) &&
        choiceRecord &&
        typeof choiceRecord.text === "string"
      ) {
        result.content += choiceRecord.text;
      }
      return result;
    },
    { content: "", thinking: "" },
  );
}

export function responsesTranscript(value: unknown): ChatTestTranscript {
  const root = record(value);
  if (!root || !Array.isArray(root.output)) return { content: "", thinking: "" };
  return root.output.reduce<ChatTestTranscript>(
    (result, item) => {
      const entry = record(item);
      if (!entry) return result;
      if (entry.type === "reasoning") {
        if (Array.isArray(entry.summary)) {
          for (const summary of entry.summary) {
            const block = record(summary);
            if (block && typeof block.text === "string") result.thinking += block.text;
          }
        }
        if (typeof entry.content === "string") result.thinking += entry.content;
        return result;
      }
      if (entry.type !== "message") return result;
      if (!Array.isArray(entry.content)) return result;
      for (const blockValue of entry.content) {
        const block = record(blockValue);
        if (block && typeof block.text === "string") result.content += block.text;
      }
      return result;
    },
    { content: "", thinking: "" },
  );
}

export function anthropicTranscript(value: unknown): ChatTestTranscript {
  const root = record(value);
  if (!root || !Array.isArray(root.content)) return { content: "", thinking: "" };
  return root.content.reduce<ChatTestTranscript>(
    (result, item) => {
      const block = record(item);
      if (!block) return result;
      if (block.type === "text" && typeof block.text === "string") result.content += block.text;
      if (block.type === "thinking" && typeof block.thinking === "string") {
        result.thinking += block.thinking;
      }
      return result;
    },
    { content: "", thinking: "" },
  );
}
