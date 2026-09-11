import { useQuery } from "@tanstack/react-query";
import { env } from "@ws-model-proxy/env/web";

export type ChatMediaConfig = {
  enabled: boolean;
  maxUploadBytes: number;
  maxAttachmentBytes: number;
};

export const chatMediaConfigQueryKey = ["chat-test", "media-config"] as const;

async function fetchChatMediaConfig(signal: AbortSignal): Promise<ChatMediaConfig> {
  const response = await fetch(`${env.VITE_SERVER_URL}/api/internal/media/config`, {
    credentials: "include",
    signal,
  });
  if (!response.ok) return { enabled: false, maxUploadBytes: 0, maxAttachmentBytes: 0 };
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("enabled" in body)) {
    return { enabled: false, maxUploadBytes: 0, maxAttachmentBytes: 0 };
  }
  const enabled = body.enabled === true;
  const maxUploadBytes =
    "maxUploadBytes" in body && typeof body.maxUploadBytes === "number" && body.maxUploadBytes > 0
      ? body.maxUploadBytes
      : 0;
  const maxAttachmentBytes =
    "maxAttachmentBytes" in body &&
    typeof body.maxAttachmentBytes === "number" &&
    body.maxAttachmentBytes > 0
      ? body.maxAttachmentBytes
      : 0;
  return { enabled, maxUploadBytes, maxAttachmentBytes };
}

export function useChatMediaConfig() {
  return useQuery({
    queryKey: chatMediaConfigQueryKey,
    queryFn: ({ signal }) => fetchChatMediaConfig(signal),
    staleTime: 5 * 60 * 1000,
  });
}
