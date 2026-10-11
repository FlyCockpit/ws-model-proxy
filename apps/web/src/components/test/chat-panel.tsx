import { useForm } from "@tanstack/react-form";
import {
  type ChatTestReasoningSelection,
  encodeReasoning,
  reasoningLevels,
} from "@ws-model-proxy/api/lib/reasoning-contract";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { Textarea } from "@ws-model-proxy/ui/components/textarea";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { Brain, ImagePlus, Loader2, MessageSquarePlus, Send, Square, X } from "lucide-react";
import { type ChangeEvent, type KeyboardEvent, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { FieldErrors } from "@/components/field-errors";
import { NativeSelect } from "@/components/native-select";
import { SegmentedControl } from "@/components/segmented-control";
import { ChatMarkdown } from "@/components/test/chat-markdown";
import { TestErrorNotice } from "@/components/test/test-error";
import { type TestChatMessage, useTestChat } from "@/hooks/use-test-chat";
import {
  acceptedAttachmentAcceptAttr,
  attachmentFileInfo,
  INLINE_ATTACHMENT_MAX_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  processImageFile,
  readFileAsDataUrl,
  TOTAL_REQUEST_HARD_MAX_BYTES,
} from "@/lib/image-attachments";
import {
  attachmentModalitiesFor,
  type TestAttachment,
  type TestSurface,
  type TestTarget,
} from "@/lib/test-relay";

const SURFACE_LABEL_KEY: Record<TestSurface, string> = {
  OPENAI_CHAT_COMPLETIONS: "dashboard:test.surface.OPENAI_CHAT_COMPLETIONS",
  OPENAI_RESPONSES: "dashboard:test.surface.OPENAI_RESPONSES",
  ANTHROPIC_MESSAGES: "dashboard:test.surface.ANTHROPIC_MESSAGES",
};

const DEFAULT_MAX_TOKENS = 1024;
const MAX_TOKENS_LIMIT = 128_000;
const REASONING_OPTIONS: readonly ChatTestReasoningSelection[] = ["unset", ...reasoningLevels];

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isReasoningSelection(value: string): value is ChatTestReasoningSelection {
  return REASONING_OPTIONS.some((option) => option === value);
}

/**
 * Chat on the Test page: the request API (where the target answers more than one), reasoning
 * level, a system prompt, attachments the target can take, and the streamed conversation with
 * its reasoning and timings. The panel is keyed by target, so a new target starts a new chat.
 */
export function ChatPanel({ target }: { target: TestTarget }) {
  const { t } = useTranslation(["dashboard"]);
  const ids = useId();
  const chat = useTestChat();
  const [chosenSurface, setChosenSurface] = useState<TestSurface | null>(null);
  const surface =
    chosenSurface && target.surfaces.includes(chosenSurface)
      ? chosenSurface
      : (target.recommendedSurface ?? "OPENAI_CHAT_COMPLETIONS");
  const [reasoning, setReasoning] = useState<ChatTestReasoningSelection>("unset");
  const [maxTokens, setMaxTokens] = useState(DEFAULT_MAX_TOKENS);
  const [system, setSystem] = useState("");
  const [attachments, setAttachments] = useState<TestAttachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const modalities = attachmentModalitiesFor(target, surface);
  const canAttach = modalities.image || modalities.audio || modalities.video;
  const attachmentMax = Math.min(
    INLINE_ATTACHMENT_MAX_BYTES,
    target.maxAttachmentBytes ?? Number.POSITIVE_INFINITY,
  );

  const form = useForm({
    defaultValues: { text: "" },
    validators: {
      onSubmit: z.object({ text: z.string().max(32_000, t("dashboard:test.chat.tooLong")) }),
    },
    onSubmit: async ({ value, formApi }) => {
      const text = value.text.trim();
      const sent = attachments.filter((attachment) => modalities[attachment.modality]);
      if (sent.length !== attachments.length) {
        // Attached before the API changed: say so rather than dropping them silently.
        setNotice(t("dashboard:test.chat.attachments.notForApi"));
        return;
      }
      if (!text && sent.length === 0) return;
      const estimate = new Blob([JSON.stringify({ messages: chat.messages, text, sent, system })])
        .size;
      if (estimate > TOTAL_REQUEST_HARD_MAX_BYTES) {
        setNotice(t("dashboard:test.chat.attachments.requestTooLarge"));
        return;
      }
      setNotice(null);
      setAttachments([]);
      formApi.reset();
      await chat.send(
        { text, attachments: sent },
        {
          surface,
          model: target.model,
          system,
          reasoning: encodeReasoning({ surface, selection: reasoning }),
          maxTokens,
          emptyMessage: t("dashboard:test.errors.empty"),
        },
      );
    },
  });

  const addFiles = async (files: File[]) => {
    const room = MAX_ATTACHMENTS_PER_MESSAGE - attachments.length;
    if (room <= 0) {
      setNotice(t("dashboard:test.chat.attachments.max", { count: MAX_ATTACHMENTS_PER_MESSAGE }));
      return;
    }
    setProcessing(true);
    const accepted: TestAttachment[] = [];
    const problems = new Set<string>();
    try {
      for (const file of files.slice(0, room)) {
        const info = attachmentFileInfo(file);
        if (!info || !modalities[info.modality]) {
          problems.add(t("dashboard:test.chat.attachments.unsupported"));
          continue;
        }
        if (info.modality === "image") {
          const result = await processImageFile(file, { maxBytes: attachmentMax });
          if (!result.ok) {
            problems.add(
              result.reason === "oversize"
                ? t("dashboard:test.chat.attachments.tooLarge", {
                    size: formatBytes(attachmentMax),
                  })
                : result.reason === "unsupported"
                  ? t("dashboard:test.chat.attachments.unsupported")
                  : t("dashboard:test.chat.attachments.unreadable", { name: file.name }),
            );
            continue;
          }
          accepted.push({
            id: result.image.id,
            name: file.name,
            modality: "image",
            dataUrl: result.image.dataUrl,
            sizeBytes: result.image.byteSize,
          });
          continue;
        }
        if (file.size > attachmentMax) {
          problems.add(
            t("dashboard:test.chat.attachments.tooLarge", { size: formatBytes(attachmentMax) }),
          );
          continue;
        }
        accepted.push({
          id: crypto.randomUUID(),
          name: file.name,
          modality: info.modality,
          dataUrl: await readFileAsDataUrl(file, info.mime),
          sizeBytes: file.size,
        });
      }
      if (files.length > room) {
        problems.add(
          t("dashboard:test.chat.attachments.max", { count: MAX_ATTACHMENTS_PER_MESSAGE }),
        );
      }
    } finally {
      setProcessing(false);
    }
    setAttachments((current) => [...current, ...accepted]);
    setNotice(problems.size > 0 ? [...problems].join(" ") : null);
  };

  const onFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = "";
    if (files.length > 0) void addFiles(files);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void form.handleSubmit();
  };

  const busy = chat.streaming || processing;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-3 md:flex-row md:flex-wrap md:items-end">
        {target.surfaces.length > 1 ? (
          <div className="flex min-w-0 flex-col gap-2">
            <span className="text-sm font-medium">{t("dashboard:test.surface.label")}</span>
            {/* The API stays put while an answer streams. */}
            <fieldset disabled={busy} className="min-w-0">
              <SegmentedControl
                ariaLabel={t("dashboard:test.surface.label")}
                value={surface}
                onChange={setChosenSurface}
                items={target.surfaces.map((value) => ({
                  value,
                  label: t(SURFACE_LABEL_KEY[value]),
                }))}
              />
            </fieldset>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("dashboard:test.surface.only", { surface: t(SURFACE_LABEL_KEY[surface]) })}
          </p>
        )}
        <div className="flex min-w-0 flex-col gap-2 md:w-48">
          <Label htmlFor={`${ids}-reasoning`}>{t("dashboard:test.reasoning.label")}</Label>
          <NativeSelect
            id={`${ids}-reasoning`}
            value={reasoning}
            disabled={busy}
            onChange={(event) => {
              if (isReasoningSelection(event.target.value)) setReasoning(event.target.value);
            }}
          >
            {REASONING_OPTIONS.map((level) => (
              <option key={level} value={level}>
                {t(`dashboard:test.reasoning.levels.${level}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
        {surface === "ANTHROPIC_MESSAGES" ? (
          <div className="flex min-w-0 flex-col gap-2 md:w-40">
            <Label htmlFor={`${ids}-max-tokens`}>{t("dashboard:test.chat.maxTokens")}</Label>
            <Input
              id={`${ids}-max-tokens`}
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_TOKENS_LIMIT}
              className="h-11"
              value={maxTokens}
              disabled={busy}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isInteger(next) && next >= 1 && next <= MAX_TOKENS_LIMIT)
                  setMaxTokens(next);
              }}
            />
          </div>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="touch"
          className="md:ms-auto"
          disabled={chat.messages.length === 0}
          onClick={() => {
            chat.reset();
            setNotice(null);
          }}
        >
          <MessageSquarePlus aria-hidden="true" className="size-4" />
          {t("dashboard:test.chat.newChat")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("dashboard:test.reasoning.help")}</p>

      <details className="min-w-0 rounded-md border">
        <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium">
          {t("dashboard:test.chat.system")}
        </summary>
        <div className="px-3 pb-3">
          <Label htmlFor={`${ids}-system`} className="sr-only">
            {t("dashboard:test.chat.system")}
          </Label>
          <Textarea
            id={`${ids}-system`}
            value={system}
            onChange={(event) => setSystem(event.target.value)}
            placeholder={t("dashboard:test.chat.systemPlaceholder")}
            rows={3}
          />
        </div>
      </details>

      <Transcript messages={chat.messages} />

      <form
        className="flex min-w-0 flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        {attachments.length > 0 ? (
          <ul
            className="flex min-w-0 flex-wrap gap-2"
            aria-label={t("dashboard:test.chat.attachments.list")}
          >
            {attachments.map((attachment) => (
              <li
                key={attachment.id}
                className="flex min-w-0 max-w-full items-center gap-1 rounded-md border bg-muted ps-2 text-xs"
              >
                <span className="min-w-0 truncate">{attachment.name}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-touch"
                  aria-label={t("dashboard:test.chat.attachments.remove", {
                    name: attachment.name,
                  })}
                  onClick={() =>
                    setAttachments((current) => current.filter((item) => item.id !== attachment.id))
                  }
                >
                  <X aria-hidden="true" className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {notice ? (
          <p className="text-sm text-destructive" role="alert">
            {notice}
          </p>
        ) : null}
        <form.Field name="text">
          {(field) => (
            <div className="flex min-w-0 flex-col gap-1">
              <Label htmlFor={`${ids}-message`} className="sr-only">
                {t("dashboard:test.chat.message")}
              </Label>
              <Textarea
                id={`${ids}-message`}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder={t("dashboard:test.chat.placeholder")}
                rows={3}
              />
              <FieldErrors field={field} />
            </div>
          )}
        </form.Field>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {canAttach ? (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                accept={acceptedAttachmentAcceptAttr(modalities)}
                onChange={onFiles}
                data-testid="chat-attachment-input"
              />
              <Button
                type="button"
                variant="outline"
                size="touch"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
              >
                {processing ? (
                  <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                ) : (
                  <ImagePlus aria-hidden="true" className="size-4" />
                )}
                {t("dashboard:test.chat.attachments.add")}
              </Button>
            </>
          ) : null}
          {chat.streaming ? (
            <Button
              type="button"
              variant="destructive"
              size="touch"
              className="ms-auto"
              onClick={chat.stop}
            >
              <Square aria-hidden="true" className="size-4" />
              {t("dashboard:test.chat.stop")}
            </Button>
          ) : (
            <form.Subscribe selector={(state) => state.values.text}>
              {(text) => (
                <Button
                  type="submit"
                  size="touch"
                  className="ms-auto"
                  disabled={busy || (!text.trim() && attachments.length === 0)}
                >
                  <Send aria-hidden="true" className="size-4" />
                  {t("dashboard:test.chat.send")}
                </Button>
              )}
            </form.Subscribe>
          )}
        </div>
      </form>
    </div>
  );
}

function Transcript({ messages }: { messages: TestChatMessage[] }) {
  const { t } = useTranslation(["dashboard"]);
  if (messages.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
        {t("dashboard:test.chat.empty")}
      </p>
    );
  }
  return (
    <>
      <ol className="flex min-w-0 flex-col gap-3">
        {messages.map((message) => (
          <li
            key={message.id}
            className={cn(
              "flex min-w-0 flex-col gap-2 rounded-lg border p-3",
              message.role === "user" ? "bg-muted/50 md:ms-12" : "md:me-12",
            )}
            data-role={message.role}
          >
            <p className="text-xs font-medium text-muted-foreground">
              {message.role === "user"
                ? t("dashboard:test.chat.you")
                : t("dashboard:test.chat.model")}
            </p>
            {message.thinking ? (
              <details
                className="min-w-0 rounded-md bg-muted/60"
                open={message.status === "streaming"}
              >
                <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-3 text-sm">
                  <Brain aria-hidden="true" className="size-4 shrink-0" />
                  {t("dashboard:test.chat.reasoning")}
                </summary>
                <p className="whitespace-pre-wrap break-words px-3 pb-3 text-sm text-muted-foreground">
                  {message.thinking}
                </p>
              </details>
            ) : null}
            {message.content ? (
              message.role === "assistant" ? (
                <ChatMarkdown content={message.content} />
              ) : (
                <p className="whitespace-pre-wrap break-words text-sm">{message.content}</p>
              )
            ) : null}
            {message.attachments.length > 0 ? (
              <p className="break-words text-xs text-muted-foreground">
                {message.attachments.map((attachment) => attachment.name).join(", ")}
              </p>
            ) : null}
            {message.status === "streaming" && !message.content && !message.thinking ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                {t("dashboard:test.chat.waiting")}
              </p>
            ) : null}
            {message.status === "stopped" ? (
              <p className="text-xs text-muted-foreground">{t("dashboard:test.chat.stopped")}</p>
            ) : null}
            {message.error ? <TestErrorNotice error={message.error} /> : null}
            {message.metrics ? <Metrics metrics={message.metrics} /> : null}
          </li>
        ))}
      </ol>
      {/* One announcement per answer, not every streamed token. */}
      <p className="sr-only" role="status">
        {t(`dashboard:test.chat.announce.${messages.at(-1)?.status ?? "ready"}`)}
      </p>
    </>
  );
}

function Metrics({ metrics }: { metrics: NonNullable<TestChatMessage["metrics"]> }) {
  const { t } = useTranslation(["dashboard"]);
  const parts = [
    metrics.ttftMs !== undefined
      ? t("dashboard:test.metrics.ttft", { ms: Math.round(metrics.ttftMs) })
      : null,
    t("dashboard:test.metrics.total", { ms: Math.round(metrics.totalMs) }),
    metrics.outputTokens !== undefined
      ? t("dashboard:test.metrics.tokens", { count: metrics.outputTokens })
      : null,
    metrics.tokensPerSecond !== undefined
      ? t("dashboard:test.metrics.rate", { rate: metrics.tokensPerSecond.toFixed(1) })
      : null,
  ].filter((part): part is string => part !== null);
  return <p className="break-words text-xs text-muted-foreground">{parts.join(" · ")}</p>;
}
