import { Button } from "@ws-model-proxy/ui/components/button";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Copy, RefreshCw, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { ChatMessage } from "./chat-test-types";

export function MessageActions({
  message,
  canRegenerate,
  onRegenerate,
}: {
  message: ChatMessage;
  canRegenerate: boolean;
  onRegenerate: (message: ChatMessage) => void;
}) {
  const { t } = useTranslation(["common", "dashboard"]);
  const copy = (value: string) =>
    void navigator.clipboard.writeText(value).then(() => toast.success(t("common:actions.copied")));
  const canRegenerateMessage =
    message.role === "assistant" &&
    (message.status === "ready" || message.status === "error" || message.status === "stopped");
  return (
    <>
      {message.status === "error" && message.errorMessage ? (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
          <p className="min-w-0 flex-1 break-words">{message.errorMessage}</p>
          <Button
            type="button"
            variant="destructive"
            size="icon"
            onClick={() => copy(message.errorMessage ?? "")}
            aria-label={t("common:actions.copy")}
            title={t("common:actions.copy")}
          >
            <Copy className="size-3.5" />
          </Button>
        </div>
      ) : null}
      {message.role === "assistant" && message.content ? (
        <div className="mt-3 flex justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={() => copy(message.content)}>
            <Copy className="size-3.5" />
            {t("common:actions.copy")}
          </Button>
        </div>
      ) : null}
      {canRegenerateMessage ? (
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
    </>
  );
}
