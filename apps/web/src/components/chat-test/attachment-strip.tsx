import { cn } from "@ws-model-proxy/ui/lib/utils";
import { AudioLines, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { ChatAttachment } from "./chat-test-types";

export function AttachmentPreview({
  attachment,
  compact = false,
}: {
  attachment: ChatAttachment;
  compact?: boolean;
}) {
  const source = attachment.kind === "data" ? attachment.dataUrl : attachment.previewUrl;
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

export function AttachmentStrip({
  attachments,
  onRemove,
}: {
  attachments: ChatAttachment[];
  onRemove?: (id: string) => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  if (attachments.length === 0) return null;
  return (
    <ul
      className="flex flex-wrap gap-2"
      aria-label={onRemove ? t("dashboard:chatTest.attachments.composerLabel") : undefined}
    >
      {attachments.map((attachment) => (
        <li
          key={attachment.id}
          className={cn("relative", attachment.expired && "opacity-40 ring-1 ring-destructive")}
        >
          <AttachmentPreview attachment={attachment} compact={Boolean(onRemove)} />
          {attachment.expired ? (
            <span
              className={
                onRemove
                  ? "absolute inset-x-0 bottom-0 rounded-b-md bg-destructive/80 px-1 py-0.5 text-center text-[10px] font-medium text-destructive-foreground"
                  : "absolute bottom-1 left-1 rounded bg-destructive/80 px-1.5 py-0.5 text-[10px] font-medium text-destructive-foreground"
              }
            >
              {t("dashboard:chatTest.attachments.expiredBadge")}
            </span>
          ) : null}
          {onRemove ? (
            <button
              type="button"
              onClick={() => onRemove(attachment.id)}
              aria-label={t("dashboard:chatTest.attachments.remove", { name: attachment.name })}
              className="absolute -right-2 -top-2 flex size-11 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
