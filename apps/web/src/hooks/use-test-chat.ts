import { useCallback, useEffect, useRef, useState } from "react";

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
 * The conversation's one request: none, or the answer being streamed with its controller.
 * This is the only thing that says whether a request is in flight (the answer message's own
 * `streaming` status is what the transcript shows for it).
 */
export type TestChatRequest =
  | { kind: "idle" }
  | { kind: "streaming"; answerId: string; controller: AbortController };

const IDLE: TestChatRequest = { kind: "idle" };

/**
 * One Test page conversation: send a turn (streamed into the last answer), stop it, start over.
 * One request at a time; the request is cancelled when the page unmounts.
 */
export function useTestChat() {
  const [messages, setMessages] = useState<TestChatMessage[]>([]);
  // The request, readable synchronously (re-entry guard) and as state (render); both are set
  // together by `setRequest` only.
  const requestRef = useRef<TestChatRequest>(IDLE);
  const [request, setRequestState] = useState<TestChatRequest>(IDLE);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const current = requestRef.current;
      if (current.kind === "streaming") current.controller.abort();
      requestRef.current = IDLE;
    };
  }, []);

  const setRequest = useCallback((next: TestChatRequest) => {
    requestRef.current = next;
    if (mountedRef.current) setRequestState(next);
  }, []);

  /** Ends `answerId`'s request, unless another one (after a reset) took its place. */
  const settle = useCallback(
    (answerId: string) => {
      const current = requestRef.current;
      if (current.kind === "streaming" && current.answerId === answerId) setRequest(IDLE);
    },
    [setRequest],
  );

  const patch = useCallback((id: string, change: (message: TestChatMessage) => TestChatMessage) => {
    if (!mountedRef.current) return;
    setMessages((current) =>
      current.map((message) => (message.id === id ? change(message) : message)),
    );
  }, []);

  const send = useCallback(
    async (input: { text: string; attachments: TestAttachment[] }, settings: TestChatSettings) => {
      if (requestRef.current.kind !== "idle") return;
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
      const controller = new AbortController();
      setRequest({ kind: "streaming", answerId: answer.id, controller });
      setMessages((current) => [...current, user, answer]);
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
            patch(answer.id, (message) => ({
              ...message,
              content: message.content + delta.content,
              thinking: message.thinking + delta.thinking,
            }));
          },
        });
        patch(answer.id, (message) => ({ ...message, status: "ready", metrics }));
      } catch (error) {
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
        settle(answer.id);
      }
    },
    [messages, patch, setRequest, settle],
  );

  const stop = useCallback(() => {
    const current = requestRef.current;
    if (current.kind === "streaming") current.controller.abort();
  }, []);

  const reset = useCallback(() => {
    const current = requestRef.current;
    if (current.kind === "streaming") current.controller.abort();
    setRequest(IDLE);
    setMessages([]);
  }, [setRequest]);

  return {
    messages,
    request: request.kind,
    streaming: request.kind === "streaming",
    send,
    stop,
    reset,
  };
}
