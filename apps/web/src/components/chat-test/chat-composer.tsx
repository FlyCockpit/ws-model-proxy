import { Button } from "@ws-model-proxy/ui/components/button";
import { Label } from "@ws-model-proxy/ui/components/label";
import { Textarea } from "@ws-model-proxy/ui/components/textarea";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { ChevronDown, ImagePlus, Loader2, Send, Square, Video } from "lucide-react";
import type {
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  FormEvent,
  KeyboardEvent,
  RefObject,
} from "react";
import { useTranslation } from "react-i18next";

import { AttachmentStrip } from "./attachment-strip";
import type { ChatAttachment } from "./chat-test-types";

export function ChatComposer(props: {
  draft: string;
  setDraft: (value: string) => void;
  systemPrompt: string;
  setSystemPrompt: (value: string) => void;
  systemPromptOpen: boolean;
  setSystemPromptOpen: React.Dispatch<React.SetStateAction<boolean>>;
  systemPromptId: string;
  systemPromptPanelId: string;
  systemPromptHelpId: string;
  attachments: ChatAttachment[];
  attachmentNotice: string;
  attachmentNoticeIsError: boolean;
  videoCompressionProgress: number | null;
  isDragging: boolean;
  isProcessingImages: boolean;
  isStreaming: boolean;
  hasModels: boolean;
  canSend: boolean;
  attachmentAcceptAttr: string;
  videoAttachmentAcceptAttr: string;
  fileInputRef: RefObject<HTMLInputElement | null>;
  videoFileInputRef: RefObject<HTMLInputElement | null>;
  draftTextareaRef: RefObject<HTMLTextAreaElement | null>;
  announcement: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onDragOver: (event: DragEvent<HTMLFormElement>) => void;
  onDragLeave: (event: DragEvent<HTMLFormElement>) => void;
  onDrop: (event: DragEvent<HTMLFormElement>) => void;
  onFileInputChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onOpenFilePicker: () => void;
  onOpenVideoFilePicker: () => void;
  onRemoveAttachment: (id: string) => void;
  onCancelVideoCompression: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onFocus: () => void;
  onStop: () => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  const {
    draft,
    setDraft,
    systemPrompt,
    setSystemPrompt,
    systemPromptOpen,
    setSystemPromptOpen,
    systemPromptId,
    systemPromptPanelId,
    systemPromptHelpId,
    attachments,
    attachmentNotice,
    attachmentNoticeIsError,
    videoCompressionProgress,
    isDragging,
    isProcessingImages,
    isStreaming,
    hasModels,
    canSend,
    attachmentAcceptAttr,
    videoAttachmentAcceptAttr,
    fileInputRef,
    videoFileInputRef,
    draftTextareaRef,
    announcement,
    onSubmit,
    onDragOver,
    onDragLeave,
    onDrop,
    onFileInputChange,
    onOpenFilePicker,
    onOpenVideoFilePicker,
    onRemoveAttachment,
    onCancelVideoCompression,
    onKeyDown,
    onPaste,
    onFocus,
    onStop,
  } = props;
  const systemPromptHasValue = systemPrompt.trim().length > 0;
  return (
    <form
      className={cn(
        "min-h-0 max-h-[min(50dvh,22rem)] shrink-0 overflow-y-auto overflow-x-clip overscroll-y-contain border-t p-2 sm:max-h-none sm:overflow-visible sm:p-3",
        isDragging && "bg-primary/5 ring-1 ring-inset ring-primary/40",
      )}
      onSubmit={onSubmit}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
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
              disabled={!hasModels || isStreaming}
              placeholder={t("dashboard:chatTest.systemPrompt.placeholder")}
              aria-describedby={systemPromptHelpId}
              className="min-h-[44px] max-h-32 resize-y text-sm"
            />
            <p id={systemPromptHelpId} className="text-xs text-muted-foreground">
              {t("dashboard:chatTest.systemPrompt.help")}
            </p>
          </div>
        </div>
        <AttachmentStrip attachments={attachments} onRemove={onRemoveAttachment} />
        {attachmentNotice ? (
          <p
            className={cn(
              "text-xs",
              attachmentNoticeIsError ? "font-medium text-destructive" : "text-muted-foreground",
            )}
            role={attachmentNoticeIsError ? "alert" : "status"}
          >
            {attachmentNotice}
          </p>
        ) : null}
        {videoCompressionProgress !== null ? (
          <div
            className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
            role="status"
          >
            <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              {t("dashboard:chatTest.attachments.compressingVideo", {
                progress: videoCompressionProgress,
              })}
            </span>
            <Button type="button" variant="ghost" size="touch" onClick={onCancelVideoCompression}>
              {t("dashboard:chatTest.attachments.cancelCompression")}
            </Button>
          </div>
        ) : null}
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept={attachmentAcceptAttr}
            multiple
            className="hidden"
            onChange={onFileInputChange}
            tabIndex={-1}
          />
          <input
            ref={videoFileInputRef}
            type="file"
            accept={videoAttachmentAcceptAttr}
            multiple
            className="hidden"
            onChange={onFileInputChange}
            tabIndex={-1}
          />
          {attachmentAcceptAttr ? (
            <Button
              type="button"
              variant="outline"
              size="icon-touch"
              onClick={onOpenFilePicker}
              disabled={!hasModels || isProcessingImages}
              aria-label={t("dashboard:chatTest.attachments.attach")}
              title={t("dashboard:chatTest.attachments.attach")}
            >
              {isProcessingImages ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ImagePlus className="size-4" />
              )}
            </Button>
          ) : null}
          {videoAttachmentAcceptAttr ? (
            <Button
              type="button"
              variant="outline"
              size="icon-touch"
              onClick={onOpenVideoFilePicker}
              disabled={!hasModels || isProcessingImages}
              aria-label={t("dashboard:chatTest.attachments.attachVideo")}
              title={t("dashboard:chatTest.attachments.attachVideo")}
            >
              {isProcessingImages ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Video className="size-4" />
              )}
            </Button>
          ) : null}
          <Textarea
            ref={draftTextareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            onFocus={onFocus}
            onPaste={onPaste}
            disabled={!hasModels}
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
              onClick={onStop}
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
  );
}
