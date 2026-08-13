import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { env } from "@ws-model-proxy/env/web";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@ws-model-proxy/ui/components/command";
import { Label } from "@ws-model-proxy/ui/components/label";
import { Popover, PopoverContent, PopoverTrigger } from "@ws-model-proxy/ui/components/popover";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Textarea } from "@ws-model-proxy/ui/components/textarea";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import {
  ArrowDown,
  AudioLines,
  ChevronDown,
  ChevronsUpDown,
  FlaskConical,
  ImagePlus,
  Loader2,
  MessageSquarePlus,
  RefreshCw,
  RotateCcw,
  Send,
  Square,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { ChatMarkdown } from "@/components/chat-markdown";
import { InlineRetry } from "@/components/inline-retry";
import { useChatScrollEngine } from "@/hooks/use-chat-scroll-engine";
import {
  type AttachmentModalities,
  type AttachmentModality,
  acceptedAttachmentAcceptAttr,
  attachmentFileInfo,
  dataUrlToBlob,
  MAX_ATTACHMENTS_PER_MESSAGE,
  PER_IMAGE_MAX_BYTES,
  processImageFile,
  readFileAsDataUrl,
  TOTAL_REQUEST_HARD_MAX_BYTES,
  TOTAL_REQUEST_SOFT_WARN_BYTES,
  UPLOAD_THRESHOLD_BYTES,
} from "@/lib/image-attachments";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/dashboard/chat-test")({
  component: ChatTestPage,
});

type VisibleModels = Awaited<ReturnType<AppRouterClient["forwarderManagement"]["visibleModels"]>>;
type ModelOption = {
  id: string;
  modelId: string;
  label: string;
  kind: "DIRECT_MODEL" | "MODEL_POOL";
  attachmentModalities: AttachmentModalities;
};
type ChatRole = "user" | "assistant";
type ChatMessageStatus = "ready" | "streaming" | "error" | "stopped";
// Attached media stored on a user message. An attachment is EITHER embedded as
// a base64 data URL (small / media disabled), OR uploaded to the ephemeral media
// store and referenced by id — in which case only a client-side preview URL is
// kept for thumbnails and a fresh signed URL is minted at send time. History
// keeps mediaIds, never signed URLs (signatures are short-lived).
type ChatAttachmentBase = {
  id: string;
  name: string;
  modality: AttachmentModality;
  // Set when a send-time /sign call reports the media id as expired/unknown, so
  // the thumbnail can be flagged and the user prompted to re-attach.
  expired?: boolean;
};
type ChatAttachmentData = ChatAttachmentBase & { kind: "data"; dataUrl: string };
type ChatAttachmentMedia = ChatAttachmentBase & {
  kind: "media";
  mediaId: string;
  previewUrl: string;
};
type ChatAttachment = ChatAttachmentData | ChatAttachmentMedia;

// Thumbnail source for an attachment: the embedded data URL, or the client-side
// object/blob preview URL for uploaded media (never the signed URL).
function attachmentPreviewSrc(attachment: ChatAttachment): string {
  return attachment.kind === "data" ? attachment.dataUrl : attachment.previewUrl;
}

function AttachmentPreview({
  attachment,
  compact = false,
}: {
  attachment: ChatAttachment;
  compact?: boolean;
}) {
  const source = attachmentPreviewSrc(attachment);
  if (attachment.modality === "image") {
    return (
      <img
        src={source}
        alt={attachment.name}
        className={
          compact
            ? "size-14 rounded-md border object-cover sm:size-16"
            : "max-h-48 max-w-full rounded-md border object-contain"
        }
      />
    );
  }
  if (attachment.modality === "audio") {
    return (
      <div
        className={cn(
          "flex min-w-48 items-center gap-2 rounded-md border bg-background p-2",
          compact && "max-w-56",
        )}
      >
        <AudioLines className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium" title={attachment.name}>
            {attachment.name}
          </p>
          <audio controls src={source} className="mt-1 h-7 w-full" />
        </div>
      </div>
    );
  }
  return (
    <video
      controls
      src={source}
      className={
        compact
          ? "h-16 w-28 rounded-md border object-cover"
          : "max-h-48 max-w-full rounded-md border object-contain"
      }
      aria-label={attachment.name}
    />
  );
}

type MediaConfigResponse = { enabled: boolean; maxUploadBytes: number };
type SignedMediaUrl = { id: string; url: string; signatureExpiresAt?: string };
type ChatTimingMetrics = {
  ttftMs?: number;
  completionTokens?: number;
  tokensPerSecond?: number;
};

type TransformDebug = {
  modelId: string;
  latencyMs: number;
  cacheHit: boolean;
  includePrimaryTools: boolean;
  toolCount: number;
  envelope: string | null;
  error: string | null;
};

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  status: ChatMessageStatus;
  sourceUserMessageId?: string;
  errorMessage?: string;
  attachments?: ChatAttachment[];
  metrics?: ChatTimingMetrics;
  transformDebug?: TransformDebug;
};
// OpenAI-shaped content parts used when a message carries media.
type RelayContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "video_url"; video_url: { url: string } }
  | { type: "input_audio_url"; input_audio: { url: string } };
type RelayChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | RelayContentPart[];
};

const LONG_THREAD_FIXTURE_COUNT = 200;

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "_")}`;
}

function modelOptions(visibleModels: VisibleModels | undefined): ModelOption[] {
  if (!visibleModels) return [];
  return [
    ...visibleModels.directModels.map((model) => ({
      id: model.id,
      modelId: model.modelId,
      label: model.upstreamModelId,
      kind: model.target,
      attachmentModalities: model.attachmentModalities,
    })),
    ...visibleModels.modelPools.map((pool) => ({
      id: pool.id,
      modelId: pool.modelId,
      label: pool.name,
      kind: pool.target,
      attachmentModalities: pool.attachmentModalities,
    })),
  ];
}

function filterModelOptions(options: ModelOption[], query: string): ModelOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return options;
  return options.filter(
    (option) =>
      option.modelId.toLowerCase().includes(needle) || option.label.toLowerCase().includes(needle),
  );
}

function ModelPicker({
  options,
  value,
  onValueChange,
  disabled = false,
}: {
  options: ModelOption[];
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation(["dashboard"]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = options.find((option) => option.modelId === value);
  const filtered = useMemo(() => filterModelOptions(options, query), [options, query]);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setQuery("");
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-label={t("dashboard:chatTest.modelPicker")}
            disabled={disabled || options.length === 0}
            className={cn(
              "h-auto min-h-[44px] min-w-0 flex-1 justify-between gap-2 py-2 font-normal whitespace-normal! md:w-80 md:flex-none",
              !selected && "text-muted-foreground",
            )}
          />
        }
      >
        <span className="min-w-0 flex-1 break-all text-left">
          {selected?.modelId ?? t("dashboard:chatTest.modelPicker")}
        </span>
        <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--anchor-width)] min-w-[min(100vw-2rem,20rem)] max-w-[calc(100vw-1rem)] p-0"
        align="end"
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t("dashboard:chatTest.modelFilterPlaceholder")}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {filtered.length === 0 ? (
              <CommandEmpty>{t("dashboard:chatTest.modelFilterEmpty")}</CommandEmpty>
            ) : (
              <CommandGroup>
                {filtered.map((option) => {
                  const isSelected = option.modelId === value;
                  return (
                    <CommandItem
                      key={`${option.kind}:${option.id}`}
                      value={option.modelId}
                      data-checked={isSelected}
                      onSelect={() => {
                        onValueChange(option.modelId);
                        setOpen(false);
                        setQuery("");
                      }}
                    >
                      <span className="min-w-0 flex-1 break-all">{option.modelId}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// Representative length stand-in for a signed media URL, used only to estimate
// the outgoing body size BEFORE signing. Uploaded attachments contribute this
// short URL rather than multi-hundred-KB base64, so the size guards effectively
// only count embedded (data-URL) attachments.
const MEDIA_URL_PLACEHOLDER = `https://${"x".repeat(48)}.example.com/media/${"y".repeat(
  36,
)}?exp=0000000000&sig=${"z".repeat(64)}`;

function relayMessages(
  messages: ChatMessage[],
  throughUserMessageId: string | undefined,
  // Resolves an uploaded attachment's media id to a URL (a freshly signed URL at
  // send time, or a fixed placeholder when estimating request size).
  resolveMediaUrl: (mediaId: string) => string,
): RelayChatMessage[] {
  const selected = throughUserMessageId
    ? messages.slice(0, messages.findIndex((message) => message.id === throughUserMessageId) + 1)
    : messages;

  return selected.flatMap<RelayChatMessage>((message) => {
    if (message.role === "assistant" && message.status !== "ready") return [];
    const hasAttachments = (message.attachments?.length ?? 0) > 0;
    const hasText = message.content.trim().length > 0;
    if (!hasText && !hasAttachments) return [];

    // Text-only messages keep the plain-string shape the route already sends.
    if (!hasAttachments) {
      return [{ role: message.role, content: message.content }];
    }

    // With media, content becomes an OpenAI-shaped content-parts array.
    const parts: RelayContentPart[] = [];
    if (hasText) parts.push({ type: "text", text: message.content });
    for (const attachment of message.attachments ?? []) {
      const url =
        attachment.kind === "data" ? attachment.dataUrl : resolveMediaUrl(attachment.mediaId);
      if (attachment.modality === "image") {
        parts.push({ type: "image_url", image_url: { url } });
      } else if (attachment.modality === "audio") {
        parts.push({ type: "input_audio_url", input_audio: { url } });
      } else {
        parts.push({ type: "video_url", video_url: { url } });
      }
    }
    return [{ role: message.role, content: parts }];
  });
}

function withSystemPrompt(messages: RelayChatMessage[], systemPrompt: string): RelayChatMessage[] {
  const content = systemPrompt.trim();
  return content ? [{ role: "system", content }, ...messages] : messages;
}

// Collect the media ids referenced by the outgoing thread (through the given
// user message), so a single /sign call can mint fresh URLs for all of them.
function collectMediaIds(messages: ChatMessage[], throughUserMessageId?: string): string[] {
  const selected = throughUserMessageId
    ? messages.slice(0, messages.findIndex((message) => message.id === throughUserMessageId) + 1)
    : messages;
  const ids = new Set<string>();
  for (const message of selected) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.kind === "media") ids.add(attachment.mediaId);
    }
  }
  return [...ids];
}

// Estimate the outgoing request body size so we can guard against the internal
// chat-test route's 10 MB Hono body limit before sending. (The CLI relay now
// streams request bodies, so its old ~8 MiB buffered cap no longer applies.)
function estimateRequestBytes(model: string, messages: RelayChatMessage[]): number {
  const body = JSON.stringify({ model, messages, stream: true });
  return new Blob([body]).size;
}

function contentDelta(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const choices = "choices" in value ? value.choices : null;
  if (!Array.isArray(choices)) return "";
  return choices
    .map((choice) => {
      if (typeof choice !== "object" || choice === null) return "";
      const delta = "delta" in choice ? choice.delta : null;
      if (typeof delta === "object" && delta !== null && "content" in delta) {
        return typeof delta.content === "string" ? delta.content : "";
      }
      if ("text" in choice) return typeof choice.text === "string" ? choice.text : "";
      return "";
    })
    .join("");
}

function standardizedCompletionTokens(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || !("wsmp_metrics" in value)) {
    return undefined;
  }
  const metrics = value.wsmp_metrics;
  if (typeof metrics !== "object" || metrics === null) return undefined;
  const tokens = "completion_tokens" in metrics ? metrics.completion_tokens : undefined;
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return undefined;
  if (!("tokenizer" in metrics) || metrics.tokenizer !== "cl100k_base") return undefined;
  return tokens;
}

async function readErrorMessage(response: Response, fallback: string) {
  const statusPrefix = `HTTP ${response.status}`;
  try {
    const payload: unknown = await response.json();
    if (typeof payload === "object" && payload !== null && "error" in payload) {
      const error = payload.error;
      if (typeof error === "object" && error !== null && "message" in error) {
        return typeof error.message === "string"
          ? `${statusPrefix}: ${error.message}`
          : `${statusPrefix}: ${fallback}`;
      }
    }
    return `${statusPrefix}: ${JSON.stringify(payload).slice(0, 400)}`;
  } catch {
    return `${statusPrefix}: ${fallback}`;
  }
}

// --- Ephemeral media store (Phase 1) --------------------------------------
// These are plain Hono routes (not oRPC), fetched in the same raw-fetch style
// as the chat-completions stream below.

const MEDIA_CONFIG_QUERY_KEY = ["chat-test", "media-config"] as const;

async function fetchMediaConfig(signal: AbortSignal): Promise<MediaConfigResponse> {
  const response = await fetch(`${env.VITE_SERVER_URL}/api/internal/media/config`, {
    credentials: "include",
    signal,
  });
  if (!response.ok) return { enabled: false, maxUploadBytes: 0 };
  const body: unknown = await response.json();
  if (typeof body === "object" && body !== null && "enabled" in body) {
    const enabled = (body as { enabled: unknown }).enabled === true;
    const maxRaw = (body as { maxUploadBytes?: unknown }).maxUploadBytes;
    const maxUploadBytes = typeof maxRaw === "number" && maxRaw > 0 ? maxRaw : 0;
    return { enabled, maxUploadBytes };
  }
  return { enabled: false, maxUploadBytes: 0 };
}

type UploadMediaResult =
  | { status: "ok"; id: string }
  | { status: "disabled" } // 501: storage not configured — fall back to base64
  | { status: "quota" } // 413 media_quota_exceeded: user is over their storage cap
  | { status: "failed" };

async function uploadMediaFile(blob: Blob, name: string): Promise<UploadMediaResult> {
  const form = new FormData();
  form.set("file", blob, name);
  try {
    const response = await fetch(`${env.VITE_SERVER_URL}/api/internal/media`, {
      method: "POST",
      credentials: "include",
      body: form,
    });
    if (response.status === 501) return { status: "disabled" };
    if (response.status === 413) {
      // Distinguish a per-user quota rejection (distinct code) from a plain
      // oversize body so the composer can show a quota-specific message.
      const body = (await response.json().catch(() => ({}))) as { code?: unknown };
      if (body.code === "media_quota_exceeded") return { status: "quota" };
      return { status: "failed" };
    }
    if (!response.ok) return { status: "failed" };
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "id" in body) {
      const id = (body as { id: unknown }).id;
      if (typeof id === "string" && id.length > 0) return { status: "ok", id };
    }
    return { status: "failed" };
  } catch {
    return { status: "failed" };
  }
}

type SignMediaResult =
  | { status: "ok"; urls: Map<string, string> }
  | { status: "expired"; invalidIds: string[] }
  | { status: "failed" };

async function signMediaUrls(ids: string[]): Promise<SignMediaResult> {
  try {
    const response = await fetch(`${env.VITE_SERVER_URL}/api/internal/media/sign`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (response.status === 403) {
      const body = (await response.json().catch(() => ({}))) as { invalidIds?: unknown };
      const invalid = Array.isArray(body.invalidIds)
        ? body.invalidIds.filter((v): v is string => typeof v === "string")
        : ids;
      return { status: "expired", invalidIds: invalid.length > 0 ? invalid : ids };
    }
    if (!response.ok) return { status: "failed" };
    const body = (await response.json()) as { urls?: unknown };
    const map = new Map<string, string>();
    if (Array.isArray(body.urls)) {
      for (const entry of body.urls as SignedMediaUrl[]) {
        if (entry && typeof entry.id === "string" && typeof entry.url === "string") {
          map.set(entry.id, entry.url);
        }
      }
    }
    return { status: "ok", urls: map };
  } catch {
    return { status: "failed" };
  }
}

async function streamChatCompletion({
  model,
  messages,
  signal,
  onDelta,
  onTransformDebug,
  fallbackErrorMessage,
}: {
  model: string;
  messages: RelayChatMessage[];
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  onTransformDebug?: (debug: TransformDebug) => void;
  fallbackErrorMessage: string;
}): Promise<ChatTimingMetrics> {
  const startedAt = performance.now();
  const response = await fetch(`${env.VITE_SERVER_URL}/api/internal/chat-test/chat/completions`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, fallbackErrorMessage));
  }
  if (!response.body) {
    throw new Error(fallbackErrorMessage);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstVisibleDeltaAt: number | undefined;
  let reportedSharedCompletionTokens: number | undefined;

  const processEvent = (event: string) => {
    const eventName = event
      .split("\n")
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new Error(`${fallbackErrorMessage} Invalid stream chunk.`);
    }
    if (eventName === "wsmp.transform") {
      if (parsed && typeof parsed === "object") onTransformDebug?.(parsed as TransformDebug);
      return;
    }
    const metrics = standardizedCompletionTokens(parsed);
    if (metrics !== undefined) reportedSharedCompletionTokens = metrics;
    const delta = contentDelta(parsed);
    if (delta) {
      firstVisibleDeltaAt ??= performance.now();
      onDelta(delta);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) processEvent(event);
  }

  buffer += decoder.decode();
  if (buffer.trim()) processEvent(buffer);

  const completedAt = performance.now();
  const ttftMs = firstVisibleDeltaAt === undefined ? undefined : firstVisibleDeltaAt - startedAt;
  const tokensPerSecond =
    reportedSharedCompletionTokens === undefined ||
    firstVisibleDeltaAt === undefined ||
    completedAt <= firstVisibleDeltaAt
      ? undefined
      : reportedSharedCompletionTokens / ((completedAt - firstVisibleDeltaAt) / 1000);
  return {
    ttftMs,
    completionTokens: reportedSharedCompletionTokens,
    tokensPerSecond,
  };
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function ChatTestPage() {
  const { t } = useTranslation(["common", "dashboard"]);
  const {
    data: visibleModelsData,
    isPending: visibleModelsIsPending,
    isError: visibleModelsIsError,
    refetch: refetchVisibleModels,
  } = useQuery(orpc.forwarderManagement.visibleModels.queryOptions());
  const queryClient = useQueryClient();
  const { data: mediaConfig } = useQuery({
    queryKey: MEDIA_CONFIG_QUERY_KEY,
    queryFn: ({ signal }) => fetchMediaConfig(signal),
    staleTime: 5 * 60 * 1000,
  });
  const mediaEnabled = mediaConfig?.enabled ?? false;
  const mediaMaxUploadBytes = mediaConfig?.maxUploadBytes ?? 0;
  const [selectedModelId, setSelectedModelId] = useState("");
  const [draft, setDraft] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  // Collapsed by default so the mobile transcript keeps most of the viewport;
  // users expand only when they need a session system prompt.
  const [systemPromptOpen, setSystemPromptOpen] = useState(false);
  const systemPromptId = useId();
  const systemPromptPanelId = `${systemPromptId}-panel`;
  const systemPromptHelpId = `${systemPromptId}-help`;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentNotice, setAttachmentNotice] = useState("");
  const [isProcessingImages, setIsProcessingImages] = useState(false);
  const [isPreparingSend, setIsPreparingSend] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const sendingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeAssistantIdRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scroll = useChatScrollEngine();
  const options = useMemo(() => modelOptions(visibleModelsData), [visibleModelsData]);
  const effectiveModelId = options.some((option) => option.modelId === selectedModelId)
    ? selectedModelId
    : (options[0]?.modelId ?? "");
  const selectedModel = options.find((option) => option.modelId === effectiveModelId);
  const attachmentModalities = selectedModel?.attachmentModalities ?? {
    image: false,
    audio: false,
    video: false,
  };
  const attachmentAcceptAttr = acceptedAttachmentAcceptAttr(attachmentModalities);
  const isStreaming = messages.some((message) => message.status === "streaming");
  const canSend =
    (draft.trim().length > 0 || attachments.length > 0) &&
    effectiveModelId.length > 0 &&
    !isStreaming &&
    !isProcessingImages &&
    !isPreparingSend;

  const handleModelChange = useCallback(
    (modelId: string) => {
      const nextModalities = options.find((option) => option.modelId === modelId)
        ?.attachmentModalities ?? { image: false, audio: false, video: false };
      setSelectedModelId(modelId);
      const retained = attachments.filter((attachment) => nextModalities[attachment.modality]);
      if (retained.length !== attachments.length) {
        for (const attachment of attachments) {
          if (!nextModalities[attachment.modality] && attachment.kind === "media") {
            URL.revokeObjectURL(attachment.previewUrl);
          }
        }
        setAttachments(retained);
        setAttachmentNotice(t("dashboard:chatTest.attachments.removedForModel"));
      }
    },
    [attachments, options, t],
  );

  const updateAssistant = useCallback((id: string, update: Partial<ChatMessage>) => {
    setMessages((current) =>
      current.map((message) => (message.id === id ? { ...message, ...update } : message)),
    );
  }, []);

  const addAttachmentFiles = useCallback(
    async (files: File[]) => {
      const supportedFiles = files.flatMap((file) => {
        const info = attachmentFileInfo(file);
        return info && attachmentModalities[info.modality] ? [{ file, ...info }] : [];
      });
      if (supportedFiles.length === 0) {
        if (files.length > 0) setAttachmentNotice(t("dashboard:chatTest.attachments.unsupported"));
        return;
      }
      const remaining = MAX_ATTACHMENTS_PER_MESSAGE - attachments.length;
      if (remaining <= 0) {
        setAttachmentNotice(
          t("dashboard:chatTest.attachments.maxReached", { count: MAX_ATTACHMENTS_PER_MESSAGE }),
        );
        return;
      }
      const toProcess = supportedFiles.slice(0, remaining);
      const truncated = supportedFiles.length > remaining;
      setIsProcessingImages(true);
      setAttachmentNotice("");
      // Media may be disabled mid-batch if an upload reports 501; track locally
      // and mirror into the query cache so later attachments skip the round trip.
      let uploadEnabled = mediaEnabled;
      try {
        const accepted: ChatAttachment[] = [];
        let rejectedCount = 0;
        let quotaHit = false;
        for (const { file, modality, mime } of toProcess) {
          if (modality !== "image") {
            const canUpload =
              uploadEnabled && (mediaMaxUploadBytes === 0 || file.size <= mediaMaxUploadBytes);
            if (canUpload) {
              const upload = await uploadMediaFile(file, file.name);
              if (upload.status === "ok") {
                accepted.push({
                  id: newId("attachment"),
                  name: file.name,
                  modality,
                  kind: "media",
                  mediaId: upload.id,
                  previewUrl: URL.createObjectURL(file),
                });
                continue;
              }
              if (upload.status === "quota") {
                quotaHit = true;
                continue;
              }
              if (upload.status === "disabled") {
                uploadEnabled = false;
                queryClient.setQueryData<MediaConfigResponse>(MEDIA_CONFIG_QUERY_KEY, {
                  enabled: false,
                  maxUploadBytes: 0,
                });
              }
            }
            // Without storage, raw audio/video must stay safely below the
            // route budget when embedded and re-sent with message history.
            if (file.size > PER_IMAGE_MAX_BYTES) {
              rejectedCount += 1;
              continue;
            }
            accepted.push({
              id: newId("attachment"),
              name: file.name,
              modality,
              kind: "data",
              dataUrl: await readFileAsDataUrl(file, mime),
            });
            continue;
          }

          const result = await processImageFile(file);
          if (!result.ok) {
            rejectedCount += 1;
            continue;
          }
          const { id, dataUrl, name, byteSize } = result.image;

          // Large enough to prefer the media store, and small enough to upload:
          // upload and keep only a media id + client-side preview URL. Otherwise
          // (or on any upload problem) keep the offline-friendly base64 path.
          const shouldUpload =
            uploadEnabled &&
            byteSize > UPLOAD_THRESHOLD_BYTES &&
            (mediaMaxUploadBytes === 0 || byteSize <= mediaMaxUploadBytes);

          if (shouldUpload) {
            const blob = dataUrlToBlob(dataUrl);
            const upload = await uploadMediaFile(blob, name);
            if (upload.status === "ok") {
              accepted.push({
                id,
                name,
                modality,
                kind: "media",
                mediaId: upload.id,
                previewUrl: URL.createObjectURL(blob),
              });
              continue;
            }
            if (upload.status === "quota") {
              // Over the per-user storage quota. Don't silently embed multi-
              // hundred-KB base64 (which history then re-sends every turn) —
              // skip this attachment and surface a quota-specific notice.
              quotaHit = true;
              continue;
            }
            if (upload.status === "disabled") {
              // Storage isn't configured after all — stop trying for this batch
              // and future ones, then fall through to the base64 path.
              uploadEnabled = false;
              queryClient.setQueryData<MediaConfigResponse>(MEDIA_CONFIG_QUERY_KEY, {
                enabled: false,
                maxUploadBytes: 0,
              });
            }
            // status "failed" or "disabled": fall back to embedding.
          }

          accepted.push({ id, name, modality, kind: "data", dataUrl });
        }
        if (accepted.length > 0) {
          setAttachments((current) => [...current, ...accepted]);
        }
        const notices: string[] = [];
        if (quotaHit) {
          notices.push(t("dashboard:chatTest.attachments.quotaExceeded"));
        }
        if (rejectedCount > 0) {
          notices.push(t("dashboard:chatTest.attachments.rejected", { count: rejectedCount }));
        }
        if (truncated) {
          notices.push(
            t("dashboard:chatTest.attachments.maxReached", { count: MAX_ATTACHMENTS_PER_MESSAGE }),
          );
        }
        setAttachmentNotice(notices.join(" "));
      } finally {
        setIsProcessingImages(false);
      }
    },
    [attachmentModalities, attachments.length, mediaEnabled, mediaMaxUploadBytes, queryClient, t],
  );

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files ? Array.from(event.target.files) : [];
      // Reset so selecting the same file again re-triggers change.
      event.target.value = "";
      if (files.length > 0) void addAttachmentFiles(files);
    },
    [addAttachmentFiles],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      // Only composer previews are revoked here; once an attachment is sent it
      // moves into message history, which keeps rendering its preview URL.
      if (removed?.kind === "media") URL.revokeObjectURL(removed.previewUrl);
      return current.filter((attachment) => attachment.id !== id);
    });
  }, []);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.clipboardData.files ?? []);
      if (files.length > 0) {
        event.preventDefault();
        void addAttachmentFiles(files);
      }
    },
    [addAttachmentFiles],
  );

  const handleDragOver = useCallback((event: DragEvent<HTMLFormElement>) => {
    if (Array.from(event.dataTransfer.types).includes("Files")) {
      event.preventDefault();
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLFormElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLFormElement>) => {
      const files = Array.from(event.dataTransfer.files ?? []);
      if (files.length > 0) {
        event.preventDefault();
        void addAttachmentFiles(files);
      }
      setIsDragging(false);
    },
    [addAttachmentFiles],
  );

  const runRelay = useCallback(
    async ({
      assistantId,
      modelId,
      relayInput,
    }: {
      assistantId: string;
      modelId: string;
      relayInput: RelayChatMessage[];
    }) => {
      const controller = new AbortController();
      abortControllerRef.current = controller;
      activeAssistantIdRef.current = assistantId;
      setAnnouncement(t("dashboard:chatTest.announcements.started"));
      try {
        const metrics = await streamChatCompletion({
          model: modelId,
          messages: relayInput,
          signal: controller.signal,
          fallbackErrorMessage: t("dashboard:chatTest.errors.streamFailed"),
          onDelta: (delta) => {
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId
                  ? { ...message, content: message.content + delta, status: "streaming" }
                  : message,
              ),
            );
            scroll.markContentChanged();
          },
          onTransformDebug: (debug) => {
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId ? { ...message, transformDebug: debug } : message,
              ),
            );
          },
        });
        updateAssistant(assistantId, { status: "ready", metrics });
        setAnnouncement(t("dashboard:chatTest.announcements.completed"));
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          updateAssistant(assistantId, { status: "stopped", metrics: undefined });
          setAnnouncement(t("dashboard:chatTest.announcements.stopped"));
        } else {
          const message =
            error instanceof Error ? error.message : t("dashboard:chatTest.errors.streamFailed");
          updateAssistant(assistantId, {
            status: "error",
            errorMessage: message,
          });
          setAnnouncement(t("dashboard:chatTest.announcements.failed"));
        }
      } finally {
        if (abortControllerRef.current === controller) abortControllerRef.current = null;
        if (activeAssistantIdRef.current === assistantId) activeAssistantIdRef.current = null;
        scroll.markContentChanged();
      }
    },
    [scroll, t, updateAssistant],
  );

  // Flag attachments whose media id came back invalid/expired from /sign, both
  // in history and in the composer, so the thumbnails show a re-attach prompt.
  const markMediaExpired = useCallback((invalidIds: string[]) => {
    const invalid = new Set(invalidIds);
    const flag = (attachment: ChatAttachment): ChatAttachment =>
      attachment.kind === "media" && invalid.has(attachment.mediaId)
        ? { ...attachment, expired: true }
        : attachment;
    setMessages((current) =>
      current.map((message) =>
        message.attachments ? { ...message, attachments: message.attachments.map(flag) } : message,
      ),
    );
    setAttachments((current) => current.map(flag));
  }, []);

  // Mint fresh signed URLs for every uploaded attachment in the outgoing thread
  // and substitute them into the OpenAI-shaped parts. Embedded (data-URL)
  // attachments need no signing. On expiry we block rather than send broken URLs.
  const buildSignedRelayInput = useCallback(
    async (
      threadMessages: ChatMessage[],
      throughUserMessageId: string,
    ): Promise<
      { ok: true; relayInput: RelayChatMessage[] } | { ok: false; reason: "expired" | "failed" }
    > => {
      const mediaIds = collectMediaIds(threadMessages, throughUserMessageId);
      if (mediaIds.length === 0) {
        return {
          ok: true,
          relayInput: withSystemPrompt(
            relayMessages(threadMessages, throughUserMessageId, () => ""),
            systemPrompt,
          ),
        };
      }
      const signed = await signMediaUrls(mediaIds);
      if (signed.status === "expired") {
        markMediaExpired(signed.invalidIds);
        return { ok: false, reason: "expired" };
      }
      if (signed.status === "failed") {
        return { ok: false, reason: "failed" };
      }
      // Fail closed: an id the /sign response omitted (present in the request but
      // missing a URL) is treated exactly like the expired/invalid case rather
      // than sent as an empty image_url. Block the send and flag the attachment.
      const missing = mediaIds.filter((id) => !signed.urls.has(id));
      if (missing.length > 0) {
        markMediaExpired(missing);
        return { ok: false, reason: "expired" };
      }
      return {
        ok: true,
        relayInput: withSystemPrompt(
          relayMessages(threadMessages, throughUserMessageId, (id) => signed.urls.get(id) ?? ""),
          systemPrompt,
        ),
      };
    },
    [markMediaExpired, systemPrompt],
  );

  const handleSend = useCallback(
    async (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      if (sendingRef.current) return;
      const content = draft.trim();
      const hasAttachments = attachments.length > 0;
      if ((!content && !hasAttachments) || !effectiveModelId || isStreaming || isProcessingImages) {
        return;
      }

      const userMessage: ChatMessage = {
        id: newId("user"),
        role: "user",
        content,
        status: "ready",
        attachments: hasAttachments ? attachments : undefined,
      };
      const assistantMessage: ChatMessage = {
        id: newId("assistant"),
        role: "assistant",
        content: "",
        status: "streaming",
        sourceUserMessageId: userMessage.id,
      };
      const nextMessages = [...messages, userMessage, assistantMessage];

      // Guard against the internal chat-test route's 10 MB body limit. History
      // re-sends every embedded image, so the whole thread is measured; uploaded
      // attachments only contribute a short signed URL (placeholder here), so the
      // guards effectively count just base64 attachments.
      const estimateInput = withSystemPrompt(
        relayMessages(nextMessages, userMessage.id, () => MEDIA_URL_PLACEHOLDER),
        systemPrompt,
      );
      const estimatedBytes = estimateRequestBytes(effectiveModelId, estimateInput);
      if (estimatedBytes > TOTAL_REQUEST_HARD_MAX_BYTES) {
        setAttachmentNotice(t("dashboard:chatTest.attachments.requestTooLarge"));
        return;
      }

      sendingRef.current = true;
      setIsPreparingSend(true);
      try {
        // Mint fresh signed URLs for uploaded attachments right before sending.
        const prepared = await buildSignedRelayInput(nextMessages, userMessage.id);
        if (!prepared.ok) {
          setAttachmentNotice(
            prepared.reason === "expired"
              ? t("dashboard:chatTest.attachments.expired")
              : t("dashboard:chatTest.attachments.signFailed"),
          );
          return;
        }

        if (estimatedBytes > TOTAL_REQUEST_SOFT_WARN_BYTES) {
          setAttachmentNotice(t("dashboard:chatTest.attachments.requestLargeWarning"));
        } else {
          setAttachmentNotice("");
        }

        setDraft("");
        setAttachments([]);
        setMessages(nextMessages);
        scroll.positionTurnNearTop(userMessage.id);
        void runRelay({
          assistantId: assistantMessage.id,
          modelId: effectiveModelId,
          relayInput: prepared.relayInput,
        });
      } finally {
        sendingRef.current = false;
        setIsPreparingSend(false);
      }
    },
    [
      attachments,
      buildSignedRelayInput,
      draft,
      systemPrompt,
      effectiveModelId,
      isProcessingImages,
      isStreaming,
      messages,
      runRelay,
      scroll,
      t,
    ],
  );

  const handleStop = useCallback(() => {
    scroll.markUserIntent();
    abortControllerRef.current?.abort();
  }, [scroll]);

  const regenerate = useCallback(
    async (assistant: ChatMessage) => {
      const sourceUserMessageId = assistant.sourceUserMessageId;
      if (!sourceUserMessageId || isStreaming) return;
      // Share send's in-flight guard so send and regenerate are mutually
      // exclusive across the whole prep+stream lifecycle: sendingRef covers the
      // /sign prep window (isStreaming is still false then), isStreaming covers
      // the relay. Without this a regenerate click during either prep window
      // could start a second concurrent relay that clobbers the abort refs.
      if (sendingRef.current) return;
      sendingRef.current = true;
      setIsPreparingSend(true);
      try {
        scroll.markUserIntent();
        // Re-sign any uploaded attachments in the replayed thread before relaying.
        const prepared = await buildSignedRelayInput(messages, sourceUserMessageId);
        if (!prepared.ok) {
          setAttachmentNotice(
            prepared.reason === "expired"
              ? t("dashboard:chatTest.attachments.expired")
              : t("dashboard:chatTest.attachments.signFailed"),
          );
          return;
        }
        setMessages((current) =>
          current.map((message) =>
            message.id === assistant.id
              ? { ...message, content: "", status: "streaming", errorMessage: undefined }
              : message,
          ),
        );
        void runRelay({
          assistantId: assistant.id,
          modelId: effectiveModelId,
          relayInput: prepared.relayInput,
        });
      } finally {
        sendingRef.current = false;
        setIsPreparingSend(false);
      }
    },
    [buildSignedRelayInput, effectiveModelId, isStreaming, messages, runRelay, scroll, t],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Enter") return;
      // Don't send while an IME composition session is active (e.g. CJK input).
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      // Shift+Enter keeps the textarea default: insert a newline.
      if (event.shiftKey) return;
      event.preventDefault();
      void handleSend();
    },
    [handleSend],
  );

  const loadFixture = useCallback(() => {
    scroll.markUserIntent();
    setMessages(
      Array.from({ length: LONG_THREAD_FIXTURE_COUNT }, (_, index) => {
        const role: ChatRole = index % 2 === 0 ? "user" : "assistant";
        const displayIndex = index + 1;
        return {
          id: newId("fixture"),
          role,
          status: "ready",
          content:
            role === "user"
              ? t("dashboard:chatTest.fixturePrompt", { index: displayIndex })
              : t("dashboard:chatTest.fixtureResponse", { index: displayIndex }),
        };
      }),
    );
    setAnnouncement(
      t("dashboard:chatTest.announcements.fixtureLoaded", {
        count: LONG_THREAD_FIXTURE_COUNT,
      }),
    );
  }, [scroll, t]);

  const startFreshChat = useCallback(() => {
    if (isStreaming || isPreparingSend) return;
    scroll.markUserIntent();
    setMessages([]);
    setDraft("");
    setSystemPrompt("");
    setSystemPromptOpen(false);
    setAttachments([]);
    setAttachmentNotice("");
    setAnnouncement(t("dashboard:chatTest.announcements.fresh"));
  }, [isPreparingSend, isStreaming, scroll, t]);

  if (visibleModelsIsPending) {
    return <ChatTestSkeleton />;
  }

  if (visibleModelsIsError) {
    return (
      <InlineRetry
        className="py-12"
        message={t("dashboard:chatTest.errors.modelsFailed")}
        onRetry={refetchVisibleModels}
      />
    );
  }

  const systemPromptHasValue = systemPrompt.trim().length > 0;

  return (
    <section className="grid h-full min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)_auto] rounded-md border bg-background">
      <div className="flex shrink-0 flex-col gap-2 border-b p-2 sm:gap-3 sm:p-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <h2 className="text-base font-semibold sm:text-lg">{t("dashboard:chatTest.title")}</h2>
          {effectiveModelId ? (
            <p
              className="mt-0.5 break-all font-mono text-xs text-muted-foreground"
              title={effectiveModelId}
            >
              {effectiveModelId}
            </p>
          ) : null}
        </div>
        <div className="flex min-w-0 items-start gap-2">
          <ModelPicker
            options={options}
            value={effectiveModelId}
            onValueChange={handleModelChange}
            disabled={isStreaming || isPreparingSend}
          />
          <Button
            type="button"
            variant="outline"
            size="icon-touch"
            disabled={isStreaming || isPreparingSend}
            onClick={startFreshChat}
            aria-label={t("dashboard:chatTest.freshChat")}
            title={t("dashboard:chatTest.freshChat")}
          >
            <MessageSquarePlus className="size-4" />
          </Button>
          {import.meta.env.DEV ? (
            <Button
              type="button"
              variant="outline"
              size="icon-touch"
              onClick={loadFixture}
              aria-label={t("dashboard:chatTest.loadFixture", {
                count: LONG_THREAD_FIXTURE_COUNT,
              })}
              title={t("dashboard:chatTest.loadFixture", { count: LONG_THREAD_FIXTURE_COUNT })}
            >
              <FlaskConical className="size-4" />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="relative min-h-0">
        <div
          ref={scroll.scrollRef}
          onScroll={scroll.markUserIntent}
          className="h-full min-h-0 overflow-y-auto overscroll-y-contain p-2 scrollbar-gutter-stable focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50 sm:p-3"
          aria-label={t("dashboard:chatTest.transcript")}
        >
          <div ref={scroll.contentRef} className="mx-auto max-w-4xl space-y-3 sm:space-y-4">
            {messages.length === 0 ? (
              <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground sm:p-8">
                {options.length === 0
                  ? t("dashboard:chatTest.emptyModels")
                  : t("dashboard:chatTest.emptyTranscript")}
              </div>
            ) : (
              messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  onRegenerate={regenerate}
                  canRegenerate={!isStreaming && !isPreparingSend && effectiveModelId.length > 0}
                />
              ))
            )}
            <div ref={scroll.liveEdgeRef} aria-hidden="true" />
          </div>
        </div>
        {scroll.hasOutOfViewUpdates ? (
          <Button
            type="button"
            size="touch"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-sm"
            onClick={scroll.jumpToLatest}
          >
            <ArrowDown className="size-4" />
            {t("dashboard:chatTest.jumpToLatest")}
          </Button>
        ) : null}
      </div>

      <form
        className={cn(
          // Cap form height on short viewports so an expanded system prompt /
          // attachment strip can scroll internally instead of clipping Send.
          "min-h-0 max-h-[min(50dvh,22rem)] shrink-0 overflow-y-auto overscroll-y-contain border-t p-2 sm:max-h-none sm:overflow-visible sm:p-3",
          isDragging && "bg-primary/5 ring-1 ring-inset ring-primary/40",
        )}
        onSubmit={handleSend}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="mx-auto flex max-w-4xl flex-col gap-2">
          <div className="space-y-1.5">
            <button
              type="button"
              className="flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-1 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-expanded={systemPromptOpen}
              aria-controls={systemPromptPanelId}
              onClick={() => setSystemPromptOpen((open) => !open)}
            >
              <span className="inline-flex min-w-0 items-center gap-2">
                <span className="truncate">
                  {systemPromptOpen
                    ? t("dashboard:chatTest.systemPrompt.toggleHide")
                    : t("dashboard:chatTest.systemPrompt.toggleShow")}
                </span>
                {systemPromptHasValue && !systemPromptOpen ? (
                  <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                    {t("dashboard:chatTest.systemPrompt.activeBadge")}
                  </span>
                ) : null}
              </span>
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  "size-4 shrink-0 transition-transform",
                  systemPromptOpen && "rotate-180",
                )}
              />
            </button>
            <div id={systemPromptPanelId} hidden={!systemPromptOpen} className="space-y-1.5">
              <Label htmlFor={systemPromptId} className="sr-only">
                {t("dashboard:chatTest.systemPrompt.label")}
              </Label>
              <Textarea
                id={systemPromptId}
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
                disabled={options.length === 0 || isStreaming}
                placeholder={t("dashboard:chatTest.systemPrompt.placeholder")}
                aria-describedby={systemPromptHelpId}
                className="min-h-[44px] max-h-32 resize-y text-sm"
              />
              <p id={systemPromptHelpId} className="text-xs text-muted-foreground">
                {t("dashboard:chatTest.systemPrompt.help")}
              </p>
            </div>
          </div>
          {attachments.length > 0 ? (
            <ul
              className="flex flex-wrap gap-2"
              aria-label={t("dashboard:chatTest.attachments.composerLabel")}
            >
              {attachments.map((attachment) => (
                <li
                  key={attachment.id}
                  className={cn(
                    "relative",
                    attachment.expired && "opacity-40 ring-1 ring-destructive",
                  )}
                >
                  <AttachmentPreview attachment={attachment} compact />
                  {attachment.expired ? (
                    <span className="absolute inset-x-0 bottom-0 rounded-b-md bg-destructive/80 px-1 py-0.5 text-center text-[10px] font-medium text-destructive-foreground">
                      {t("dashboard:chatTest.attachments.expiredBadge")}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => removeAttachment(attachment.id)}
                    aria-label={t("dashboard:chatTest.attachments.remove", {
                      name: attachment.name,
                    })}
                    className="absolute -right-2 -top-2 flex size-7 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:size-6"
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {attachmentNotice ? (
            <p className="text-xs text-muted-foreground" role="status">
              {attachmentNotice}
            </p>
          ) : null}
          <div className="flex items-end gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept={attachmentAcceptAttr}
              multiple
              className="hidden"
              onChange={handleFileInputChange}
              tabIndex={-1}
            />
            <Button
              type="button"
              variant="outline"
              size="icon-touch"
              onClick={openFilePicker}
              disabled={options.length === 0 || isProcessingImages || !attachmentAcceptAttr}
              aria-label={t("dashboard:chatTest.attachments.attach")}
              title={t("dashboard:chatTest.attachments.attach")}
            >
              {isProcessingImages ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ImagePlus className="size-4" />
              )}
            </Button>
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={scroll.markUserIntent}
              onPaste={handlePaste}
              disabled={options.length === 0}
              placeholder={t("dashboard:chatTest.inputPlaceholder")}
              aria-label={t("dashboard:chatTest.inputLabel")}
              inputMode="text"
              autoComplete="off"
              rows={1}
              className="max-h-32 min-h-11 flex-1 resize-none text-base sm:max-h-40 sm:min-h-[72px] sm:resize-y md:text-sm"
            />
            {isStreaming ? (
              <Button
                type="button"
                variant="outline"
                size="icon-touch"
                onClick={handleStop}
                aria-label={t("dashboard:chatTest.stop")}
                title={t("dashboard:chatTest.stop")}
              >
                <Square className="size-4" />
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon-touch"
                disabled={!canSend}
                aria-label={t("dashboard:chatTest.send")}
                title={t("dashboard:chatTest.send")}
              >
                <Send className="size-4" />
              </Button>
            )}
          </div>
        </div>
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {announcement}
        </div>
      </form>
    </section>
  );
}

function ChatTestSkeleton() {
  return (
    <div className="grid h-full min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)_auto] rounded-md border p-2 sm:p-3">
      <div className="mb-2 flex items-center gap-2 sm:mb-3">
        <Skeleton className="h-6 w-28 sm:h-7 sm:w-40" />
        <Skeleton className="ml-auto h-11 min-w-0 flex-1 md:max-w-80" />
        <Skeleton className="size-11 shrink-0" />
      </div>
      <div className="min-h-0 space-y-4 overflow-hidden border-y py-4">
        <Skeleton className="h-24 w-3/4" />
        <Skeleton className="ml-auto h-32 w-4/5" />
        <Skeleton className="h-24 w-2/3" />
      </div>
      <div className="mt-2 flex items-end gap-2 sm:mt-3">
        <Skeleton className="size-11 shrink-0" />
        <Skeleton className="h-11 min-w-0 flex-1 sm:h-20" />
        <Skeleton className="size-11 shrink-0" />
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  onRegenerate,
  canRegenerate,
}: {
  message: ChatMessage;
  onRegenerate: (message: ChatMessage) => void;
  canRegenerate: boolean;
}) {
  const { t } = useTranslation(["dashboard"]);
  const isAssistant = message.role === "assistant";
  const showRegenerate =
    isAssistant &&
    (message.status === "ready" || message.status === "error" || message.status === "stopped");

  return (
    <article
      data-scroll-anchor={message.id}
      data-turn-id={message.id}
      className={cn(
        "max-w-[92%] rounded-md border p-3 [contain-intrinsic-size:0_9rem] [content-visibility:auto]",
        isAssistant ? "mr-auto bg-muted/40" : "ml-auto bg-primary/10",
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">
          {isAssistant ? t("dashboard:chatTest.assistant") : t("dashboard:chatTest.user")}
        </p>
        {message.status === "streaming" ? (
          <span className="text-xs text-muted-foreground">
            {t("dashboard:chatTest.status.streaming")}
          </span>
        ) : null}
        {message.status === "stopped" ? (
          <span className="text-xs text-muted-foreground">
            {t("dashboard:chatTest.status.stopped")}
          </span>
        ) : null}
      </div>
      {message.attachments && message.attachments.length > 0 ? (
        <ul className="mb-2 flex flex-wrap gap-2">
          {message.attachments.map((attachment) => (
            <li
              key={attachment.id}
              className={cn("relative", attachment.expired && "opacity-40 ring-1 ring-destructive")}
            >
              <AttachmentPreview attachment={attachment} />
              {attachment.expired ? (
                <span className="absolute bottom-1 left-1 rounded bg-destructive/80 px-1.5 py-0.5 text-[10px] font-medium text-destructive-foreground">
                  {t("dashboard:chatTest.attachments.expiredBadge")}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {message.content ? (
        <MessageContent content={message.content} />
      ) : message.attachments && message.attachments.length > 0 ? null : (
        <p className="text-sm text-muted-foreground">{t("dashboard:chatTest.status.waiting")}</p>
      )}
      {isAssistant && message.metrics?.ttftMs !== undefined ? (
        <p className="mt-3 text-xs tabular-nums text-muted-foreground">
          {t("dashboard:chatTest.metrics.ttft", {
            value: (message.metrics.ttftMs / 1000).toFixed(2),
          })}
          <span aria-hidden="true"> · </span>
          {message.metrics.tokensPerSecond !== undefined
            ? t("dashboard:chatTest.metrics.tokensPerSecondShared", {
                value: message.metrics.tokensPerSecond.toFixed(1),
                count: message.metrics.completionTokens ?? 0,
              })
            : t("dashboard:chatTest.metrics.throughputUnavailable")}
        </p>
      ) : null}
      {isAssistant && message.transformDebug ? (
        <details className="mt-3 rounded-md border border-border/70 bg-muted/30 p-2 text-xs">
          <summary className="cursor-pointer font-medium">
            {t("dashboard:chatTest.transform.title")}
          </summary>
          <p className="mt-2 text-muted-foreground">
            {t("dashboard:chatTest.transform.summary", {
              model: message.transformDebug.modelId,
              latency: (message.transformDebug.latencyMs / 1000).toFixed(2),
              cache: message.transformDebug.cacheHit
                ? t("dashboard:chatTest.transform.cacheHit")
                : t("dashboard:chatTest.transform.cacheMiss"),
              tools: message.transformDebug.includePrimaryTools
                ? message.transformDebug.toolCount
                : 0,
            })}
          </p>
          {message.transformDebug.envelope ? (
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]">
              {message.transformDebug.envelope}
            </pre>
          ) : null}
        </details>
      ) : null}
      {message.status === "error" && message.errorMessage ? (
        <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
          {message.errorMessage}
        </p>
      ) : null}
      {showRegenerate ? (
        <div className="mt-3 flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canRegenerate}
            onClick={() => onRegenerate(message)}
          >
            {message.status === "error" ? (
              <RefreshCw className="size-3.5" />
            ) : (
              <RotateCcw className="size-3.5" />
            )}
            {message.status === "error"
              ? t("dashboard:chatTest.retry")
              : t("dashboard:chatTest.regenerate")}
          </Button>
        </div>
      ) : null}
    </article>
  );
}

function MessageContent({ content }: { content: string }) {
  return <ChatMarkdown content={content} />;
}
