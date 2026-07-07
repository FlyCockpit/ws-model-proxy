import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { env } from "@ws-model-proxy/env/web";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ws-model-proxy/ui/components/select";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Textarea } from "@ws-model-proxy/ui/components/textarea";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { ArrowDown, FlaskConical, RefreshCw, RotateCcw, Send, Square } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { useChatScrollEngine } from "@/hooks/use-chat-scroll-engine";
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
};
type ChatRole = "user" | "assistant";
type ChatMessageStatus = "ready" | "streaming" | "error" | "stopped";
type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  status: ChatMessageStatus;
  sourceUserMessageId?: string;
  errorMessage?: string;
};
type RelayChatMessage = {
  role: "user" | "assistant";
  content: string;
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
    })),
    ...visibleModels.modelPools.map((pool) => ({
      id: pool.id,
      modelId: pool.modelId,
      label: pool.name,
      kind: pool.target,
    })),
  ];
}

function relayMessages(messages: ChatMessage[], throughUserMessageId?: string): RelayChatMessage[] {
  const selected = throughUserMessageId
    ? messages.slice(0, messages.findIndex((message) => message.id === throughUserMessageId) + 1)
    : messages;

  return selected.flatMap((message) => {
    if (message.role === "assistant" && message.status !== "ready") return [];
    if (message.content.trim().length === 0) return [];
    return [{ role: message.role, content: message.content } satisfies RelayChatMessage];
  });
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

async function readErrorMessage(response: Response, fallback: string) {
  try {
    const payload: unknown = await response.json();
    if (typeof payload === "object" && payload !== null && "error" in payload) {
      const error = payload.error;
      if (typeof error === "object" && error !== null && "message" in error) {
        return typeof error.message === "string" ? error.message : fallback;
      }
    }
  } catch {
    return fallback;
  }
  return fallback;
}

async function streamChatCompletion({
  model,
  messages,
  signal,
  onDelta,
  fallbackErrorMessage,
}: {
  model: string;
  messages: RelayChatMessage[];
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  fallbackErrorMessage: string;
}) {
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

  const processEvent = (event: string) => {
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") return;
    const parsed: unknown = JSON.parse(data);
    const delta = contentDelta(parsed);
    if (delta) onDelta(delta);
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
  const [selectedModelId, setSelectedModelId] = useState("");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeAssistantIdRef = useRef<string | null>(null);
  const scroll = useChatScrollEngine();
  const options = useMemo(() => modelOptions(visibleModelsData), [visibleModelsData]);
  const effectiveModelId = options.some((option) => option.modelId === selectedModelId)
    ? selectedModelId
    : (options[0]?.modelId ?? "");
  const isStreaming = messages.some((message) => message.status === "streaming");
  const canSend = draft.trim().length > 0 && effectiveModelId.length > 0 && !isStreaming;

  const updateAssistant = useCallback((id: string, update: Partial<ChatMessage>) => {
    setMessages((current) =>
      current.map((message) => (message.id === id ? { ...message, ...update } : message)),
    );
  }, []);

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
        await streamChatCompletion({
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
        });
        updateAssistant(assistantId, { status: "ready" });
        setAnnouncement(t("dashboard:chatTest.announcements.completed"));
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          updateAssistant(assistantId, { status: "stopped" });
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

  const handleSend = useCallback(
    (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      const content = draft.trim();
      if (!content || !effectiveModelId || isStreaming) return;

      const userMessage: ChatMessage = {
        id: newId("user"),
        role: "user",
        content,
        status: "ready",
      };
      const assistantMessage: ChatMessage = {
        id: newId("assistant"),
        role: "assistant",
        content: "",
        status: "streaming",
        sourceUserMessageId: userMessage.id,
      };
      const nextMessages = [...messages, userMessage, assistantMessage];
      setDraft("");
      setMessages(nextMessages);
      scroll.positionTurnNearTop(userMessage.id);
      void runRelay({
        assistantId: assistantMessage.id,
        modelId: effectiveModelId,
        relayInput: relayMessages(nextMessages, userMessage.id),
      });
    },
    [draft, effectiveModelId, isStreaming, messages, runRelay, scroll],
  );

  const handleStop = useCallback(() => {
    scroll.markUserIntent();
    abortControllerRef.current?.abort();
  }, [scroll]);

  const regenerate = useCallback(
    (assistant: ChatMessage) => {
      if (!assistant.sourceUserMessageId || isStreaming) return;
      scroll.markUserIntent();
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
        relayInput: relayMessages(messages, assistant.sourceUserMessageId),
      });
    },
    [effectiveModelId, isStreaming, messages, runRelay, scroll],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        handleSend();
      }
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

  return (
    <section className="grid h-full min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)_auto] rounded-md border bg-background">
      <div className="flex flex-col gap-3 border-b p-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{t("dashboard:chatTest.title")}</h2>
        </div>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          <Select
            value={effectiveModelId}
            onValueChange={(value) => setSelectedModelId(value ?? "")}
          >
            <SelectTrigger
              className="min-h-[44px] w-full min-w-0 sm:w-80"
              aria-label={t("dashboard:chatTest.modelPicker")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {options.map((option) => (
                <SelectItem key={`${option.kind}:${option.id}`} value={option.modelId}>
                  <span className="min-w-0 truncate">{option.modelId}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {import.meta.env.DEV ? (
            <Button type="button" variant="outline" size="touch" onClick={loadFixture}>
              <FlaskConical className="size-4" />
              {t("dashboard:chatTest.loadFixture", { count: LONG_THREAD_FIXTURE_COUNT })}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="relative min-h-0">
        <div
          ref={scroll.scrollRef}
          onScroll={scroll.markUserIntent}
          className="h-full min-h-0 overflow-y-auto overscroll-y-auto p-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
          aria-label={t("dashboard:chatTest.transcript")}
        >
          <div ref={scroll.contentRef} className="mx-auto max-w-4xl space-y-4">
            {messages.length === 0 ? (
              <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
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
                  canRegenerate={!isStreaming && effectiveModelId.length > 0}
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

      <form className="border-t p-3" onSubmit={handleSend}>
        <div className="mx-auto flex max-w-4xl flex-col gap-2 sm:flex-row sm:items-end">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={scroll.markUserIntent}
            disabled={options.length === 0}
            placeholder={t("dashboard:chatTest.inputPlaceholder")}
            aria-label={t("dashboard:chatTest.inputLabel")}
            inputMode="text"
            autoComplete="off"
            className="max-h-40 min-h-[72px] text-base md:text-sm"
          />
          <div className="flex gap-2 sm:flex-col">
            {isStreaming ? (
              <Button type="button" variant="outline" size="touch" onClick={handleStop}>
                <Square className="size-4" />
                {t("dashboard:chatTest.stop")}
              </Button>
            ) : (
              <Button type="submit" size="touch" disabled={!canSend}>
                <Send className="size-4" />
                {t("dashboard:chatTest.send")}
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
    <div className="grid h-full min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)_auto] rounded-md border p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-11 w-80" />
      </div>
      <div className="min-h-0 space-y-4 overflow-hidden border-y py-4">
        <Skeleton className="h-24 w-3/4" />
        <Skeleton className="ml-auto h-32 w-4/5" />
        <Skeleton className="h-24 w-2/3" />
      </div>
      <div className="mt-3 flex gap-2">
        <Skeleton className="h-20 flex-1" />
        <Skeleton className="h-11 w-24" />
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
      {message.content ? (
        <MessageContent content={message.content} />
      ) : (
        <p className="text-sm text-muted-foreground">{t("dashboard:chatTest.status.waiting")}</p>
      )}
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
  const parts = useMemo(() => parseContentParts(content), [content]);
  return (
    <div className="space-y-3 text-sm leading-relaxed">
      {parts.map((part) =>
        part.kind === "code" ? (
          <pre
            key={part.id}
            className="overflow-x-auto rounded-md border bg-background p-3 text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
          >
            <code>{part.content}</code>
          </pre>
        ) : (
          <p key={part.id} className="whitespace-pre-wrap break-words">
            {part.content}
          </p>
        ),
      )}
    </div>
  );
}

type ContentPart = {
  id: string;
  kind: "text" | "code";
  content: string;
};

function parseContentParts(content: string): ContentPart[] {
  const parts: ContentPart[] = [];
  const pattern = /```(?:[^\n`]*)?\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let index = 0;
  for (const match of content.matchAll(pattern)) {
    if (match.index > lastIndex) {
      parts.push({
        id: `text-${index}`,
        kind: "text",
        content: content.slice(lastIndex, match.index),
      });
      index += 1;
    }
    parts.push({
      id: `code-${index}`,
      kind: "code",
      content: match[1] ?? "",
    });
    index += 1;
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) {
    parts.push({ id: `text-${index}`, kind: "text", content: content.slice(lastIndex) });
  }
  return parts.length > 0 ? parts : [{ id: "text-0", kind: "text", content }];
}
