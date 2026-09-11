import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  encodeReasoning,
  reasoningSelectorState,
} from "@ws-model-proxy/api/lib/reasoning-contract";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@ws-model-proxy/ui/components/drawer";
import { Popover, PopoverContent, PopoverTrigger } from "@ws-model-proxy/ui/components/popover";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { FlaskConical, MessageSquarePlus, Settings2 } from "lucide-react";
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

import { ChatComposer } from "@/components/chat-test/chat-composer";
import { ChatTestSkeleton as ChatTestSkeletonView } from "@/components/chat-test/chat-test-skeleton";
import type {
  ChatAttachment,
  ChatMessage,
  ChatRole,
  ChatTestSurface,
  ModelOption,
  RelayChatMessage,
  VisibleModels,
} from "@/components/chat-test/chat-test-types";
import { ChatTranscript } from "@/components/chat-test/chat-transcript";
import { ModelPicker } from "@/components/chat-test/model-picker";
import { RequestSettingsFields } from "@/components/chat-test/request-settings";
import { InlineRetry } from "@/components/inline-retry";
import { useAbortOnUnmount } from "@/hooks/use-abort-on-unmount";
import { useAutosizeTextarea } from "@/hooks/use-autosize-textarea";
import { useChatAttachments } from "@/hooks/use-chat-attachments";
import { chatMediaConfigQueryKey, useChatMediaConfig } from "@/hooks/use-chat-media-config";
import { useChatRelaySettings } from "@/hooks/use-chat-relay-settings";
import { useChatScrollEngine } from "@/hooks/use-chat-scroll-engine";
import { useChatThread } from "@/hooks/use-chat-thread";
import { useIsDesktop } from "@/hooks/use-media-query";
import { signMediaUrls, uploadMediaFile } from "@/lib/chat-test-media";
import {
  relayMessages as buildRelayMessages,
  collectMediaIds as collectRelayMediaIds,
  estimateRequestBytes as estimateRelayRequestBytes,
  mediaUrlPlaceholder,
  streamChatCompletion,
  withSystemPrompt as withRelaySystemPrompt,
} from "@/lib/chat-test-relay";
import {
  acceptedAttachmentAcceptAttr,
  attachmentFileInfo,
  INLINE_ATTACHMENT_MAX_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  processImageFile,
  readFileAsDataUrl,
  TOTAL_REQUEST_HARD_MAX_BYTES,
  TOTAL_REQUEST_SOFT_WARN_BYTES,
} from "@/lib/image-attachments";
import { compressVideoToFit } from "@/lib/video-compression";
import { orpc } from "@/utils/orpc";

// The route entry supplies its locale param so this feature component remains portable.

type MediaConfigResponse = {
  enabled: boolean;
  maxUploadBytes: number;
  maxAttachmentBytes: number;
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
      maxAttachmentBytes: model.maxAttachmentBytes,
      reasoning: model.reasoning,
    })),
    ...visibleModels.modelPools.map((pool) => ({
      id: pool.id,
      modelId: pool.modelId,
      label: pool.name,
      kind: pool.target,
      attachmentModalities: pool.attachmentModalities,
      maxAttachmentBytes: pool.maxAttachmentBytes,
      reasoning: pool.reasoning,
      compatibility: pool.compatibility,
    })),
  ];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)} MB`;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

export function ChatTestPage({ lang }: { lang: string }) {
  const { t } = useTranslation(["common", "dashboard"]);
  const {
    data: visibleModelsData,
    isPending: visibleModelsIsPending,
    isError: visibleModelsIsError,
    refetch: refetchVisibleModels,
  } = useQuery(orpc.forwarderManagement.visibleModels.queryOptions());
  const queryClient = useQueryClient();
  const { data: mediaConfig } = useChatMediaConfig();
  const mediaEnabled = mediaConfig?.enabled ?? false;
  const mediaMaxUploadBytes = mediaConfig?.maxUploadBytes ?? 0;
  const {
    selectedModelId,
    setSelectedModelId,
    routingMode,
    setRoutingMode,
    surfaceSelection,
    setSurfaceSelection,
    reasoningSelection,
    setReasoningSelection,
    requestSettingsOpen,
    setRequestSettingsOpen,
    anthropicMaxTokens,
    setAnthropicMaxTokens,
    handleSurfaceChange: applySurfaceChange,
    handleRoutingModeChange: applyRoutingModeChange,
  } = useChatRelaySettings();
  const [draft, setDraft] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  // Collapsed by default so the mobile transcript keeps most of the viewport;
  // users expand only when they need a session system prompt.
  const [systemPromptOpen, setSystemPromptOpen] = useState(false);
  const systemPromptId = useId();
  const systemPromptPanelId = `${systemPromptId}-panel`;
  const systemPromptHelpId = `${systemPromptId}-help`;
  const [announcement, setAnnouncement] = useState("");
  const {
    attachments,
    setAttachments,
    attachmentNotice,
    setAttachmentNotice,
    attachmentNoticeIsError,
    setAttachmentNoticeIsError,
    isProcessingImages,
    setIsProcessingImages,
    videoCompressionProgress,
    setVideoCompressionProgress,
    isDragging,
    setIsDragging,
  } = useChatAttachments<ChatAttachment>();
  const [isPreparingSend, setIsPreparingSend] = useState(false);
  const videoCompressionAbortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const videoFileInputRef = useRef<HTMLInputElement | null>(null);
  const draftTextareaRef = useAutosizeTextarea(draft);
  const isDesktop = useIsDesktop();
  const isAddingAttachmentsRef = useRef(false);
  const isMountedRef = useAbortOnUnmount(videoCompressionAbortRef);
  const scroll = useChatScrollEngine();
  const { messages, setMessages, sendingRef, abortControllerRef, activeAssistantIdRef } =
    useChatThread<ChatMessage>();
  const options = useMemo(() => modelOptions(visibleModelsData), [visibleModelsData]);
  // Select the first visible model only for a new Chat Test. If a previously
  // selected model disappears, leave the control unset rather than silently
  // sending with its former surface/routing controls against a different model.
  const effectiveModelId =
    selectedModelId === ""
      ? (options[0]?.modelId ?? "")
      : options.some((option) => option.modelId === selectedModelId)
        ? selectedModelId
        : "";
  const selectedModel = options.find((option) => option.modelId === effectiveModelId);
  const recommendedSurface = selectedModel?.compatibility?.recommendedSurface;
  const isPool = selectedModel?.kind === "MODEL_POOL";
  const effectiveSurface: ChatTestSurface | null =
    selectedModel?.kind === "DIRECT_MODEL"
      ? "OPENAI_CHAT_COMPLETIONS"
      : surfaceSelection === "PREFERRED"
        ? recommendedSurface === "OPENAI_CHAT_COMPLETIONS" ||
          recommendedSurface === "OPENAI_RESPONSES" ||
          recommendedSurface === "ANTHROPIC_MESSAGES"
          ? recommendedSurface
          : null
        : surfaceSelection;
  const surfaceReasoning = effectiveSurface
    ? selectedModel?.reasoning[effectiveSurface]
    : undefined;
  const selectorState = reasoningSelectorState({
    surface: effectiveSurface ?? "OPENAI_CHAT_COMPLETIONS",
    routingMode,
    reasoning: surfaceReasoning ?? {},
  });
  const effectiveReasoningSelection =
    !selectorState.hidden && selectorState.options.includes(reasoningSelection)
      ? reasoningSelection
      : "unset";
  const reasoningHelp = !selectorState.hidden
    ? [
        selectorState.levelsUnknown
          ? t("dashboard:chatTest.reasoning.unknownLevels")
          : t("dashboard:chatTest.reasoning.help"),
        effectiveSurface === "ANTHROPIC_MESSAGES" &&
        routingMode === "PREFER_NATIVE" &&
        effectiveReasoningSelection === "none"
          ? t("dashboard:chatTest.reasoning.anthropicNoneHelp")
          : null,
      ]
        .filter((message): message is string => message !== null)
        .join(" ")
    : "";
  const encodedReasoning =
    effectiveSurface && routingMode !== "REQUIRE_ADAPTED"
      ? encodeReasoning({
          surface: effectiveSurface,
          selection: effectiveReasoningSelection,
          config: surfaceReasoning
            ? {
                ...(surfaceReasoning.supportedLevels
                  ? { supportedLevels: surfaceReasoning.supportedLevels }
                  : {}),
                ...(surfaceReasoning.defaultLevel
                  ? { defaultLevel: surfaceReasoning.defaultLevel }
                  : {}),
                ...(surfaceReasoning.encoding ? { encoding: surfaceReasoning.encoding } : {}),
              }
            : undefined,
        })
      : {};
  const effectiveAnthropicMaxTokens = Math.max(
    anthropicMaxTokens,
    typeof encodedReasoning.max_tokens === "number" ? encodedReasoning.max_tokens : 0,
  );
  const attachmentMaxBytes = Math.min(
    mediaConfig && mediaConfig.maxAttachmentBytes > 0
      ? mediaConfig.maxAttachmentBytes
      : Number.POSITIVE_INFINITY,
    selectedModel?.maxAttachmentBytes ?? Number.POSITIVE_INFINITY,
  );
  const attachmentModalities = selectedModel?.attachmentModalities ?? {
    image: false,
    audio: false,
    video: false,
  };
  const attachmentAcceptAttr = acceptedAttachmentAcceptAttr({
    ...attachmentModalities,
    video: false,
  });
  const videoAttachmentAcceptAttr = acceptedAttachmentAcceptAttr({
    image: false,
    audio: false,
    video: attachmentModalities.video,
  });
  const isStreaming = messages.some((message) => message.status === "streaming");
  const canSend =
    (draft.trim().length > 0 || attachments.length > 0) &&
    effectiveModelId.length > 0 &&
    effectiveSurface !== null &&
    !isStreaming &&
    !isProcessingImages &&
    !isPreparingSend;

  const clearAttachmentNotice = useCallback(() => {
    setAttachmentNotice("");
    setAttachmentNoticeIsError(false);
  }, []);

  const showAttachmentFailure = useCallback((message: string) => {
    setAttachmentNotice(message);
    setAttachmentNoticeIsError(true);
    toast.error(message);
  }, []);

  const handleSurfaceChange = applySurfaceChange;
  const handleRoutingModeChange = applyRoutingModeChange;

  const handleModelChange = useCallback(
    (modelId: string) => {
      const nextModel = options.find((option) => option.modelId === modelId);
      const nextModalities = nextModel?.attachmentModalities ?? {
        image: false,
        audio: false,
        video: false,
      };
      const nextAttachmentMaxBytes = Math.min(
        mediaConfig && mediaConfig.maxAttachmentBytes > 0
          ? mediaConfig.maxAttachmentBytes
          : Number.POSITIVE_INFINITY,
        nextModel?.maxAttachmentBytes ?? Number.POSITIVE_INFINITY,
      );
      setSelectedModelId(modelId);
      setReasoningSelection("unset");
      if (nextModel?.kind === "DIRECT_MODEL") {
        setSurfaceSelection("PREFERRED");
        setRoutingMode("PREFER_NATIVE");
      }
      const retained = attachments.filter(
        (attachment) =>
          nextModalities[attachment.modality] && attachment.sizeBytes <= nextAttachmentMaxBytes,
      );
      if (retained.length !== attachments.length) {
        for (const attachment of attachments) {
          if (
            (!nextModalities[attachment.modality] ||
              attachment.sizeBytes > nextAttachmentMaxBytes) &&
            attachment.kind === "media"
          ) {
            URL.revokeObjectURL(attachment.previewUrl);
          }
        }
        setAttachments(retained);
        setAttachmentNotice(t("dashboard:chatTest.attachments.removedForModelLimit"));
        setAttachmentNoticeIsError(false);
      }
    },
    [attachments, mediaConfig, options, t],
  );

  const updateAssistant = useCallback((id: string, update: Partial<ChatMessage>) => {
    setMessages((current) =>
      current.map((message) => (message.id === id ? { ...message, ...update } : message)),
    );
  }, []);

  const addAttachmentFiles = useCallback(
    async (files: File[]) => {
      if (isAddingAttachmentsRef.current) return;
      const supportedFiles = files.flatMap((file) => {
        const info = attachmentFileInfo(file);
        return info && attachmentModalities[info.modality] ? [{ file, ...info }] : [];
      });
      if (supportedFiles.length === 0) {
        if (files.length > 0)
          showAttachmentFailure(t("dashboard:chatTest.attachments.unsupported"));
        return;
      }
      const remaining = MAX_ATTACHMENTS_PER_MESSAGE - attachments.length;
      if (remaining <= 0) {
        showAttachmentFailure(
          t("dashboard:chatTest.attachments.maxReached", { count: MAX_ATTACHMENTS_PER_MESSAGE }),
        );
        return;
      }
      const toProcess = supportedFiles.slice(0, remaining);
      const truncated = supportedFiles.length > remaining;
      isAddingAttachmentsRef.current = true;
      setIsProcessingImages(true);
      clearAttachmentNotice();
      // Media may be disabled mid-batch if an upload reports 501; track locally
      // and mirror into the query cache so later attachments skip the round trip.
      let uploadEnabled = mediaEnabled;
      try {
        const accepted: ChatAttachment[] = [];
        let rejectedCount = 0;
        let quotaHit = false;
        let mediaStoreRequired = false;
        let uploadTooLargeMaxBytes: number | undefined;
        let compressionNotice = "";
        let compressedVideoSize: number | null = null;
        for (const { file, modality, mime } of toProcess) {
          if (!isMountedRef.current) return;
          if (modality !== "image") {
            let uploadFile = file;
            let wasCompressed = false;
            if (modality === "video" && file.size > attachmentMaxBytes && uploadEnabled) {
              const controller = new AbortController();
              videoCompressionAbortRef.current = controller;
              if (isMountedRef.current) setVideoCompressionProgress(0);
              const compression = await compressVideoToFit({
                file,
                maxBytes: attachmentMaxBytes,
                signal: controller.signal,
                onProgress: (progress) => {
                  if (!isMountedRef.current) return;
                  const percentage = Math.round(progress * 100);
                  setVideoCompressionProgress((current) =>
                    current === percentage ? current : percentage,
                  );
                },
              });
              if (videoCompressionAbortRef.current === controller) {
                videoCompressionAbortRef.current = null;
                if (isMountedRef.current) setVideoCompressionProgress(null);
              }
              if (compression.status === "compressed") {
                uploadFile = compression.file;
                wasCompressed = true;
              } else {
                compressionNotice ||= t(
                  `dashboard:chatTest.attachments.${
                    compression.status === "tooLong"
                      ? "videoTooLong"
                      : compression.status === "cannotFit"
                        ? "videoCannotFit"
                        : compression.status === "cancelled"
                          ? "videoCompressionCancelled"
                          : compression.status === "unsupported"
                            ? "videoCompressionUnsupported"
                            : "videoCompressionFailed"
                  }`,
                );
                continue;
              }
            }
            if (uploadFile.size > attachmentMaxBytes) {
              uploadTooLargeMaxBytes ??= attachmentMaxBytes;
              continue;
            }
            const exceedsUploadLimit =
              mediaMaxUploadBytes > 0 && uploadFile.size > mediaMaxUploadBytes;
            const canUpload = uploadEnabled && !exceedsUploadLimit;
            if (canUpload) {
              const upload = await uploadMediaFile(uploadFile, uploadFile.name);
              if (upload.status === "ok") {
                accepted.push({
                  id: newId("attachment"),
                  name: uploadFile.name,
                  modality,
                  sizeBytes: uploadFile.size,
                  kind: "media",
                  mediaId: upload.id,
                  previewUrl: URL.createObjectURL(uploadFile),
                });
                if (wasCompressed) compressedVideoSize ??= uploadFile.size;
                continue;
              }
              if (upload.status === "quota") {
                quotaHit = true;
                continue;
              }
              if (upload.status === "tooLarge") {
                uploadTooLargeMaxBytes ??= upload.maxBytes ?? mediaMaxUploadBytes;
                continue;
              }
              if (upload.status === "disabled") {
                uploadEnabled = false;
                queryClient.setQueryData<MediaConfigResponse>(chatMediaConfigQueryKey, {
                  enabled: false,
                  maxUploadBytes: 0,
                  maxAttachmentBytes: attachmentMaxBytes,
                });
              }
            }
            if (uploadFile.size > Math.min(INLINE_ATTACHMENT_MAX_BYTES, attachmentMaxBytes)) {
              if (uploadEnabled && exceedsUploadLimit) {
                uploadTooLargeMaxBytes ??= mediaMaxUploadBytes;
              } else {
                mediaStoreRequired = true;
              }
              continue;
            }
            accepted.push({
              id: newId("attachment"),
              name: uploadFile.name,
              modality,
              sizeBytes: uploadFile.size,
              kind: "data",
              dataUrl: await readFileAsDataUrl(uploadFile, mime),
            });
            continue;
          }

          if (file.size > attachmentMaxBytes) {
            uploadTooLargeMaxBytes ??= attachmentMaxBytes;
            continue;
          }

          if (uploadEnabled) {
            const exceedsUploadLimit = mediaMaxUploadBytes > 0 && file.size > mediaMaxUploadBytes;
            if (exceedsUploadLimit) {
              uploadTooLargeMaxBytes ??= mediaMaxUploadBytes;
              continue;
            }
            const upload = await uploadMediaFile(file, file.name);
            if (upload.status === "ok") {
              accepted.push({
                id: newId("attachment"),
                name: file.name,
                modality,
                sizeBytes: file.size,
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
            if (upload.status === "tooLarge") {
              uploadTooLargeMaxBytes ??= upload.maxBytes ?? mediaMaxUploadBytes;
              continue;
            }
            if (upload.status === "disabled") {
              uploadEnabled = false;
              queryClient.setQueryData<MediaConfigResponse>(chatMediaConfigQueryKey, {
                enabled: false,
                maxUploadBytes: 0,
                maxAttachmentBytes: attachmentMaxBytes,
              });
            }
          }

          const result = await processImageFile(file, {
            maxBytes: Math.min(INLINE_ATTACHMENT_MAX_BYTES, attachmentMaxBytes),
          });
          if (!result.ok) {
            rejectedCount += 1;
            continue;
          }
          const { id, dataUrl, name, byteSize } = result.image;

          accepted.push({ id, name, modality, sizeBytes: byteSize, kind: "data", dataUrl });
        }
        if (!isMountedRef.current) return;
        if (accepted.length > 0) {
          setAttachments((current) => [...current, ...accepted]);
        }
        const notices: string[] = [];
        if (quotaHit) {
          notices.push(t("dashboard:chatTest.attachments.quotaExceeded"));
        }
        if (mediaStoreRequired) {
          notices.push(
            t("dashboard:chatTest.attachments.mediaStoreRequired", {
              size: formatBytes(INLINE_ATTACHMENT_MAX_BYTES),
            }),
          );
        }
        if (uploadTooLargeMaxBytes) {
          notices.push(
            t("dashboard:chatTest.attachments.uploadTooLarge", {
              size: formatBytes(uploadTooLargeMaxBytes),
            }),
          );
        }
        if (compressedVideoSize !== null) {
          notices.push(
            t("dashboard:chatTest.attachments.videoCompressed", {
              size: formatBytes(compressedVideoSize),
            }),
          );
        }
        if (compressionNotice) notices.push(compressionNotice);
        if (rejectedCount > 0) {
          notices.push(t("dashboard:chatTest.attachments.rejected", { count: rejectedCount }));
        }
        if (truncated) {
          notices.push(
            t("dashboard:chatTest.attachments.maxReached", { count: MAX_ATTACHMENTS_PER_MESSAGE }),
          );
        }
        const notice = notices.join(" ");
        if (notice) {
          const hasHardFailure =
            quotaHit ||
            mediaStoreRequired ||
            uploadTooLargeMaxBytes !== undefined ||
            rejectedCount > 0 ||
            compressionNotice.length > 0;
          if (hasHardFailure) showAttachmentFailure(notice);
          else {
            setAttachmentNotice(notice);
            setAttachmentNoticeIsError(false);
          }
        }
      } finally {
        isAddingAttachmentsRef.current = false;
        if (isMountedRef.current) setIsProcessingImages(false);
      }
    },
    [
      attachmentMaxBytes,
      attachmentModalities,
      attachments.length,
      mediaEnabled,
      mediaMaxUploadBytes,
      queryClient,
      t,
      isMountedRef,
      clearAttachmentNotice,
      showAttachmentFailure,
    ],
  );

  const cancelVideoCompression = useCallback(() => {
    videoCompressionAbortRef.current?.abort();
  }, []);

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const openVideoFilePicker = useCallback(() => {
    videoFileInputRef.current?.click();
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
          routingMode,
          surface: effectiveSurface ?? "OPENAI_CHAT_COMPLETIONS",
          reasoning: encodedReasoning,
          anthropicMaxTokens: effectiveAnthropicMaxTokens,
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
          onThinkingDelta: (thinking) => {
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      thinking: (message.thinking ?? "") + thinking,
                      status: "streaming",
                    }
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
    [
      effectiveAnthropicMaxTokens,
      effectiveSurface,
      encodedReasoning,
      routingMode,
      scroll,
      t,
      updateAssistant,
    ],
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
      const mediaIds = collectRelayMediaIds(threadMessages, throughUserMessageId);
      if (mediaIds.length === 0) {
        return {
          ok: true,
          relayInput: withRelaySystemPrompt(
            buildRelayMessages(threadMessages, throughUserMessageId, () => ""),
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
        relayInput: withRelaySystemPrompt(
          buildRelayMessages(
            threadMessages,
            throughUserMessageId,
            (id) => signed.urls.get(id) ?? "",
          ),
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
      const estimateInput = withRelaySystemPrompt(
        buildRelayMessages(nextMessages, userMessage.id, () => mediaUrlPlaceholder),
        systemPrompt,
      );
      const estimatedBytes = estimateRelayRequestBytes(effectiveModelId, estimateInput);
      if (estimatedBytes > TOTAL_REQUEST_HARD_MAX_BYTES) {
        showAttachmentFailure(t("dashboard:chatTest.attachments.requestTooLarge"));
        return;
      }

      sendingRef.current = true;
      setIsPreparingSend(true);
      try {
        // Mint fresh signed URLs for uploaded attachments right before sending.
        const prepared = await buildSignedRelayInput(nextMessages, userMessage.id);
        if (!prepared.ok) {
          showAttachmentFailure(
            prepared.reason === "expired"
              ? t("dashboard:chatTest.attachments.expired")
              : t("dashboard:chatTest.attachments.signFailed"),
          );
          return;
        }

        if (estimatedBytes > TOTAL_REQUEST_SOFT_WARN_BYTES) {
          setAttachmentNotice(t("dashboard:chatTest.attachments.requestLargeWarning"));
          setAttachmentNoticeIsError(false);
        } else {
          clearAttachmentNotice();
        }

        setDraft("");
        setAttachments([]);
        // The empty selection displays the first model only as a new-chat
        // convenience. Once that implicit choice is actually used, persist it
        // so a visible-model query refresh or reorder cannot change the model
        // for later turns in this chat.
        setSelectedModelId((current) => current || effectiveModelId);
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
      clearAttachmentNotice,
      showAttachmentFailure,
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
        // A regenerate replays the thread through this assistant turn. Remove
        // subsequent turns first so the transcript remains an exact view of
        // the conversation sent to the relay.
        const assistantIndex = messages.findIndex((message) => message.id === assistant.id);
        if (assistantIndex < 0) return;
        const replayedMessages = messages.slice(0, assistantIndex + 1);
        // Re-sign any uploaded attachments in the replayed thread before relaying.
        const prepared = await buildSignedRelayInput(replayedMessages, sourceUserMessageId);
        if (!prepared.ok) {
          showAttachmentFailure(
            prepared.reason === "expired"
              ? t("dashboard:chatTest.attachments.expired")
              : t("dashboard:chatTest.attachments.signFailed"),
          );
          return;
        }
        setMessages((current) =>
          current.slice(0, assistantIndex + 1).map((message) =>
            message.id === assistant.id
              ? {
                  ...message,
                  content: "",
                  thinking: undefined,
                  status: "streaming",
                  errorMessage: undefined,
                }
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
    [
      buildSignedRelayInput,
      effectiveModelId,
      isStreaming,
      messages,
      runRelay,
      scroll,
      showAttachmentFailure,
      t,
    ],
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
    clearAttachmentNotice();
    setReasoningSelection("unset");
    setAnnouncement(t("dashboard:chatTest.announcements.fresh"));
  }, [clearAttachmentNotice, isPreparingSend, isStreaming, scroll, t]);

  if (visibleModelsIsPending) {
    return <ChatTestSkeletonView />;
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

  return (
    <section className="grid h-full min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)_auto] rounded-md border bg-background">
      <div className="flex shrink-0 flex-col gap-2 border-b bg-background p-2 sm:gap-3 sm:p-3 md:sticky md:top-0 md:z-10 md:flex-row md:items-start md:justify-between">
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
        <div className="flex min-w-0 flex-wrap items-start justify-end gap-2">
          <ModelPicker
            options={options}
            value={effectiveModelId}
            onValueChange={handleModelChange}
            disabled={isStreaming || isPreparingSend}
          />
          {effectiveSurface ? (
            <span className="inline-flex min-h-11 max-w-full items-center rounded-full border bg-muted px-3 text-xs text-muted-foreground">
              {t(`dashboard:chatTest.surface.${effectiveSurface}`)}
            </span>
          ) : null}
          {isPool ? (
            <span className="inline-flex min-h-11 max-w-full items-center rounded-full border bg-muted px-3 text-xs text-muted-foreground">
              {t(`dashboard:chatTest.routingMode.${routingMode}`)}
            </span>
          ) : null}
          {!selectorState.hidden ? (
            <span className="inline-flex min-h-11 max-w-full items-center rounded-full border bg-muted px-3 text-xs text-muted-foreground">
              {t(`dashboard:chatTest.reasoning.levels.${effectiveReasoningSelection}`)}
            </span>
          ) : null}
          {isDesktop ? (
            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    size="touch"
                    disabled={isStreaming || isPreparingSend}
                  />
                }
              >
                <Settings2 className="size-4" />
                {t("dashboard:chatTest.requestSettings")}
              </PopoverTrigger>
              <PopoverContent className="w-80 p-4" align="end">
                <RequestSettingsFields
                  idPrefix="chat-test-desktop"
                  isPool={Boolean(isPool)}
                  selectedModel={selectedModel}
                  surfaceSelection={surfaceSelection}
                  effectiveSurface={effectiveSurface}
                  recommendedSurface={recommendedSurface}
                  routingMode={routingMode}
                  selectorState={selectorState}
                  effectiveReasoningSelection={effectiveReasoningSelection}
                  reasoningHelp={reasoningHelp}
                  anthropicMaxTokens={anthropicMaxTokens}
                  onAnthropicMaxTokensChange={setAnthropicMaxTokens}
                  disabled={isStreaming || isPreparingSend}
                  onSurfaceChange={handleSurfaceChange}
                  onRoutingModeChange={handleRoutingModeChange}
                  onReasoningChange={setReasoningSelection}
                />
              </PopoverContent>
            </Popover>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="touch"
              disabled={isStreaming || isPreparingSend}
              onClick={() => setRequestSettingsOpen(true)}
            >
              <Settings2 className="size-4" />
              {t("dashboard:chatTest.requestSettings")}
            </Button>
          )}
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
      {!isDesktop ? (
        <Drawer open={requestSettingsOpen} onOpenChange={setRequestSettingsOpen}>
          <DrawerContent
            overlayClassName="md:hidden"
            style={{ paddingBottom: "var(--safe-area-bottom)" }}
          >
            <DrawerHeader>
              <DrawerTitle>{t("dashboard:chatTest.requestSettings")}</DrawerTitle>
              <DrawerDescription>{t("dashboard:chatTest.requestSettingsHelp")}</DrawerDescription>
            </DrawerHeader>
            <div className="overflow-y-auto overflow-x-hidden overscroll-contain px-4 pb-4">
              <RequestSettingsFields
                idPrefix="chat-test-mobile"
                isPool={Boolean(isPool)}
                selectedModel={selectedModel}
                surfaceSelection={surfaceSelection}
                effectiveSurface={effectiveSurface}
                recommendedSurface={recommendedSurface}
                routingMode={routingMode}
                selectorState={selectorState}
                effectiveReasoningSelection={effectiveReasoningSelection}
                reasoningHelp={reasoningHelp}
                anthropicMaxTokens={anthropicMaxTokens}
                onAnthropicMaxTokensChange={setAnthropicMaxTokens}
                disabled={isStreaming || isPreparingSend}
                onSurfaceChange={handleSurfaceChange}
                onRoutingModeChange={handleRoutingModeChange}
                onReasoningChange={setReasoningSelection}
              />
            </div>
          </DrawerContent>
        </Drawer>
      ) : null}

      <ChatTranscript
        lang={lang}
        hasModels={options.length > 0}
        messages={messages}
        scroll={scroll}
        onSamplePrompt={setDraft}
        onRegenerate={regenerate}
        canRegenerate={!isStreaming && !isPreparingSend && effectiveModelId.length > 0}
      />

      <ChatComposer
        draft={draft}
        setDraft={setDraft}
        systemPrompt={systemPrompt}
        setSystemPrompt={setSystemPrompt}
        systemPromptOpen={systemPromptOpen}
        setSystemPromptOpen={setSystemPromptOpen}
        systemPromptId={systemPromptId}
        systemPromptPanelId={systemPromptPanelId}
        systemPromptHelpId={systemPromptHelpId}
        attachments={attachments}
        attachmentNotice={attachmentNotice}
        attachmentNoticeIsError={attachmentNoticeIsError}
        videoCompressionProgress={videoCompressionProgress}
        isDragging={isDragging}
        isProcessingImages={isProcessingImages}
        isStreaming={isStreaming}
        hasModels={options.length > 0}
        canSend={canSend}
        attachmentAcceptAttr={attachmentAcceptAttr}
        videoAttachmentAcceptAttr={videoAttachmentAcceptAttr}
        fileInputRef={fileInputRef}
        videoFileInputRef={videoFileInputRef}
        draftTextareaRef={draftTextareaRef}
        announcement={announcement}
        onSubmit={handleSend}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onFileInputChange={handleFileInputChange}
        onOpenFilePicker={openFilePicker}
        onOpenVideoFilePicker={openVideoFilePicker}
        onRemoveAttachment={removeAttachment}
        onCancelVideoCompression={cancelVideoCompression}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onFocus={scroll.markUserIntent}
        onStop={handleStop}
      />
    </section>
  );
}
