import { Link } from "@tanstack/react-router";
import { escapeForDisplay } from "@ws-model-proxy/config/display-escape";
import { Button, buttonVariants } from "@ws-model-proxy/ui/components/button";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { Bot } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { usePendingAgentRequests } from "@/hooks/use-pending-agent-requests";

/**
 * Dashboard-wide notice while an MCP agent waits for the user to confirm a
 * supervised command. Dismissing hides it for the requests shown until a new
 * one arrives.
 */
export function AgentRequestsNotice({ lang }: { lang: string }) {
  const { t } = useTranslation("dashboard");
  const { requests } = usePendingAgentRequests();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const waiting = requests.filter(
    (request) =>
      (request.status === "awaiting_user" || request.status === "awaiting_output_review") &&
      !dismissed.has(request.commandId),
  );
  const first = waiting[0];
  if (!first) return null;
  return (
    <div
      className="mb-4 flex min-w-0 flex-col gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 sm:flex-row sm:items-center"
      role="status"
    >
      <Bot className="hidden size-5 shrink-0 text-amber-600 sm:block" aria-hidden="true" />
      <div className="min-w-0 flex-1 text-sm text-amber-950 dark:text-amber-100">
        <p className="font-medium">
          {t("dashboard:agentRequests.noticeTitle", { count: waiting.length })}
        </p>
        <p className="break-words">
          {t("dashboard:agentRequests.noticeBody", {
            requester: escapeForDisplay(first.requester),
          })}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link
          to="/$lang/dashboard/terminals"
          params={{ lang }}
          className={cn(buttonVariants({ size: "touch" }))}
        >
          {t("dashboard:agentRequests.open")}
        </Link>
        <Button
          type="button"
          size="touch"
          variant="outline"
          onClick={() =>
            setDismissed(
              (current) => new Set([...current, ...waiting.map((request) => request.commandId)]),
            )
          }
        >
          {t("dashboard:notices.dismiss")}
        </Button>
      </div>
    </div>
  );
}
