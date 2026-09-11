import { cn } from "@ws-model-proxy/ui/lib/utils";
import { useTranslation } from "react-i18next";

import { ChatMarkdown } from "@/components/chat-markdown";

import { AttachmentStrip } from "./attachment-strip";
import type { ChatMessage } from "./chat-test-types";
import { MessageActions } from "./message-actions";
import { MetricsRow } from "./metrics-row";
import { ThinkingPanel } from "./thinking-panel";
import { TransformDebugPanel } from "./transform-debug-panel";

export function ChatMessageView({
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
            <span className="ml-0.5 inline-block animate-pulse" aria-hidden="true">
              ▍
            </span>
          </span>
        ) : null}
        {message.status === "stopped" ? (
          <span className="text-xs text-muted-foreground">
            {t("dashboard:chatTest.status.stopped")}
          </span>
        ) : null}
      </div>
      {message.attachments ? (
        <div className="mb-2">
          <AttachmentStrip attachments={message.attachments} />
        </div>
      ) : null}
      {message.content ? (
        <ChatMarkdown content={message.content} />
      ) : message.thinking || message.attachments?.length ? null : (
        <p className="text-sm text-muted-foreground">{t("dashboard:chatTest.status.waiting")}</p>
      )}
      {isAssistant && message.thinking ? (
        <ThinkingPanel thinking={message.thinking} streaming={message.status === "streaming"} />
      ) : null}
      {isAssistant && message.metrics ? <MetricsRow metrics={message.metrics} /> : null}
      {isAssistant && message.transformDebug ? (
        <TransformDebugPanel debug={message.transformDebug} />
      ) : null}
      <MessageActions message={message} canRegenerate={canRegenerate} onRegenerate={onRegenerate} />
    </article>
  );
}
