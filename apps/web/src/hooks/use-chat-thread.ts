import { useReducer, useRef } from "react";

/** A reducer-backed setter keeps the thread's ordered transcript atomic while
 * preserving the familiar functional-update call sites used by relay events. */
export function useChatThread<Message>() {
  const [messages, dispatch] = useReducer(
    (
      current: Message[],
      action: { type: "replace"; next: Message[] | ((current: Message[]) => Message[]) },
    ) => (typeof action.next === "function" ? action.next(current) : action.next),
    [],
  );
  const sendingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeAssistantIdRef = useRef<string | null>(null);

  return {
    messages,
    setMessages: (next: Message[] | ((current: Message[]) => Message[])) =>
      dispatch({ type: "replace", next }),
    sendingRef,
    abortControllerRef,
    activeAssistantIdRef,
  };
}
