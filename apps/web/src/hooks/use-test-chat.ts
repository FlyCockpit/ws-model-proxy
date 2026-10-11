import { useCallback, useRef, useState } from "react";

import { useAbortOnUnmount } from "@/hooks/use-abort-on-unmount";
import {
  type ChatMetrics,
  chatRequest,
  streamTestChat,
  type TestAttachment,
  type TestChatTurn,
  type TestErrorInfo,
  type TestSurface,
  testErrorOf,
} from "@/lib/test-relay";

export type TestChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking: string;
  attachments: TestAttachment[];
  status: "ready" | "streaming" | "error" | "stopped";
  error?: TestErrorInfo;
  metrics?: ChatMetrics;
};

export type TestChatSettings = {
  surface: TestSurface;
  model: string;
  system: string;
  reasoning: Record<string, unknown>;
  maxTokens: number;
  /** The message for a successful answer with no text at all. */
  emptyMessage: string;
};

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

/**
 * The finished exchanges sent as history: a turn whose answer failed or was stopped is left out
 * with its answer, so roles keep alternating (strict chat templates refuse two user turns).
 */
function historyTurns(messages: TestChatMessage[]): TestChatTurn[] {
  const turns: TestChatTurn[] = [];
  for (let at = 0; at < messages.length; at += 1) {
    const message = messages[at];
    if (message?.role !== "user") continue;
    const answer = messages[at + 1];
    if (answer?.role !== "assistant" || answer.status !== "ready") continue;
    turns.push({ role: "user", content: message.content, attachments: message.attachments });
    turns.push({ role: "assistant", content: answer.content });
  }
  return turns;
}

/**
 * One Test page conversation: send a turn (streamed into the last answer), stop it, start over.
 * One request at a time; the request is cancelled when the page unmounts.
 */
export function useTestChat() {
  const [messages, setMessages] = useState<TestChatMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useAbortOnUnmount(abortRef);
  const streaming = messages.some((message) => message.status === "streaming");

  const patch = useCallback((id: string, change: (message: TestChatMessage) => TestChatMessage) => {
    setMessages((current) =>
      current.map((message) => (message.id === id ? change(message) : message)),
    );
  }, []);

  const send = useCallback(
    async (input: { text: string; attachments: TestAttachment[] }, settings: TestChatSettings) => {
      if (abortRef.current) return;
      const user: TestChatMessage = {
        id: newId("user"),
        role: "user",
        content: input.text,
        thinking: "",
        attachments: input.attachments,
        status: "ready",
      };
      const answer: TestChatMessage = {
        id: newId("answer"),
        role: "assistant",
        content: "",
        thinking: "",
        attachments: [],
        status: "streaming",
      };
      const turns: TestChatTurn[] = [
        ...historyTurns(messages),
        { role: "user", content: input.text, attachments: input.attachments },
      ];
      setMessages((current) => [...current, user, answer]);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const metrics = await streamTestChat({
          surface: settings.surface,
          request: chatRequest({
            surface: settings.surface,
            model: settings.model,
            turns,
            system: settings.system,
            reasoning: settings.reasoning,
            maxTokens: settings.maxTokens,
          }),
          signal: controller.signal,
          emptyMessage: settings.emptyMessage,
          onDelta: (delta) => {
            if (!mountedRef.current) return;
            patch(answer.id, (message) => ({
              ...message,
              content: message.content + delta.content,
              thinking: message.thinking + delta.thinking,
            }));
          },
        });
        if (mountedRef.current)
          patch(answer.id, (message) => ({ ...message, status: "ready", metrics }));
      } catch (error) {
        if (!mountedRef.current) return;
        if (controller.signal.aborted) {
          patch(answer.id, (message) => ({ ...message, status: "stopped" }));
        } else {
          patch(answer.id, (message) => ({
            ...message,
            status: "error",
            error: testErrorOf(error),
          }));
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [messages, mountedRef, patch],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
  }, []);

  return { messages, streaming, send, stop, reset };
}
