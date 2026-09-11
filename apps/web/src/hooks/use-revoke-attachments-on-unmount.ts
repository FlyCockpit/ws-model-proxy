import { useEffect, useRef } from "react";

import type { ChatAttachment, ChatMessage } from "@/components/chat-test/chat-test-types";
import {
  revokeDiscardedAttachments,
  revokeDiscardedMessageAttachments,
} from "@/lib/chat-test-media";

/**
 * Releases blob preview URLs for every uploaded attachment still held by the
 * thread or composer when the Chat Test page unmounts.
 */
export function useRevokeAttachmentsOnUnmount(
  messages: readonly ChatMessage[],
  attachments: readonly ChatAttachment[],
) {
  const latestRef = useRef({ messages, attachments });

  useEffect(() => {
    latestRef.current = { messages, attachments };
  }, [messages, attachments]);

  useEffect(
    () => () => {
      revokeDiscardedMessageAttachments(latestRef.current.messages);
      revokeDiscardedAttachments(latestRef.current.attachments);
    },
    [],
  );
}
