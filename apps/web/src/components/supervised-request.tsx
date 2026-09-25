import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatBoundedStream } from "@ws-model-proxy/config/cli-command-output";
import { escapeForDisplay } from "@ws-model-proxy/config/display-escape";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Checkbox } from "@ws-model-proxy/ui/components/checkbox";
import { ResponsiveDialog } from "@ws-model-proxy/ui/components/responsive-dialog";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Textarea } from "@ws-model-proxy/ui/components/textarea";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { Bot } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ReviewCapture, TerminalTab } from "@/hooks/use-terminal-sessions";
import { isConflict, isNotFound } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

/** Statuses in which the review checkbox can still change what the CLI sends. */
const REVIEW_TOGGLE_STATUSES: ReadonlySet<string> = new Set(["awaiting_user", "running"]);

/** An agent request whose command finished and whose output waits for this viewer's review. */
export function tabAwaitsReview(tab: TerminalTab): boolean {
  if (tab.origin !== "agent" || !tab.reviewCapture || !tab.supervised) return false;
  if (tab.phase === "exited" || tab.phase === "rejected") return false;
  // The capture only arrives after the command exited with review on. The
  // relay's list may still say `running` for a moment.
  return tab.supervised.status === "awaiting_output_review" || tab.supervised.status === "running";
}

/** The exact text the agent would receive for this capture. */
export function reviewCaptureText(capture: ReviewCapture): string {
  return formatBoundedStream(capture).text;
}

/** How an agent request's terminal ended, for the notice. */
export function agentFinishedKey(
  tab: TerminalTab,
): { key: string; values: Record<string, string | number> } | null {
  if (tab.origin !== "agent" || tab.phase !== "exited") return null;
  // The request's own status says whether the command ran; the terminal's
  // exit code alone would call a declined request "finished (exit 0)".
  const status = tab.supervised?.status;
  if (status === "declined" || status === "expired" || status === "rejected") {
    return { key: `dashboard:agentRequests.notRun.${status}`, values: {} };
  }
  if (status === "cancelled") return { key: "dashboard:agentRequests.cancelled", values: {} };
  if (status === "awaiting_user") return { key: "dashboard:agentRequests.ended", values: {} };
  if (tab.exitSignal) {
    return { key: "dashboard:agentRequests.finishedSignal", values: { signal: tab.exitSignal } };
  }
  if (tab.exitCode !== null) {
    return { key: "dashboard:agentRequests.finished", values: { code: tab.exitCode } };
  }
  return { key: "dashboard:agentRequests.ended", values: {} };
}

/** The command's size, as the CLI confirm screen states it. */
export function commandSize(command: string): { lines: number; bytes: number } {
  return {
    lines: command.split("\n").length,
    bytes: new TextEncoder().encode(command).byteLength,
  };
}

/**
 * The request details for an agent terminal: who asked, the agent's reason,
 * the command, and the output-review checkbox. Everything here is text; the
 * CLI's own confirm screen in the terminal is what will actually run. Agent-
 * and server-supplied text goes through the same escaping as that screen, so
 * bidi overrides, zero-width and other invisible characters show as `\u{…}`.
 */
export function AgentRequestPanel({
  tab,
  onView,
  onReviewOutputChange,
}: {
  tab: TerminalTab;
  onView: () => void;
  onReviewOutputChange: (on: boolean) => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  const checkboxId = useId();
  const supervised = tab.supervised;
  const finished = agentFinishedKey(tab);
  const size = supervised ? commandSize(supervised.command) : null;
  const canToggle =
    supervised?.shareOutput === true &&
    REVIEW_TOGGLE_STATUSES.has(supervised.status) &&
    tab.phase !== "exited";
  return (
    <div className="shrink-0 border-b border-(--term-border) bg-(--term-chrome) px-4 py-3 text-sm text-(--term-fg)">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Bot className="size-4 shrink-0 text-amber-400" aria-hidden="true" />
        <span className="font-medium">{t("dashboard:agentRequests.title")}</span>
        {supervised?.requester ? (
          <span className="max-w-full truncate rounded-full border border-amber-400/50 bg-amber-400/10 px-2 py-0.5 text-xs text-amber-200">
            {t("dashboard:agentRequests.requestedBy", {
              requester: escapeForDisplay(supervised.requester),
            })}
          </span>
        ) : null}
        {supervised ? (
          <span className="text-xs text-(--term-muted)">
            {t(`dashboard:agentRequests.status.${supervised.status}`)}
          </span>
        ) : null}
      </div>
      {supervised?.reason ? (
        <p className="mt-2 min-w-0 break-words text-(--term-muted)">
          <span className="text-(--term-fg)">{t("dashboard:agentRequests.reason")}</span>{" "}
          <span className="whitespace-pre-wrap">{escapeForDisplay(supervised.reason)}</span>
        </p>
      ) : null}
      {supervised ? (
        <div className="mt-2 min-w-0">
          <p className="text-xs text-(--term-muted)">
            {supervised.cwd
              ? t("dashboard:agentRequests.commandIn", { cwd: escapeForDisplay(supervised.cwd) })
              : t("dashboard:agentRequests.command")}
            {size ? (
              <>
                {" · "}
                {t("dashboard:agentRequests.commandSize", {
                  count: size.lines,
                  bytes: size.bytes,
                })}
              </>
            ) : null}
          </p>
          <pre className="mt-1 max-h-32 max-w-full overflow-x-auto overflow-y-auto overscroll-contain whitespace-pre-wrap break-all rounded-md bg-(--term-bg) px-3 py-2 font-mono text-xs">
            {escapeForDisplay(supervised.command)}
          </pre>
          <p className="mt-1 text-xs text-(--term-muted)">
            {supervised.shareOutput
              ? t("dashboard:agentRequests.outputShared")
              : t("dashboard:agentRequests.outputPrivate")}
          </p>
        </div>
      ) : null}
      {tab.decline === "sent" && tab.phase !== "exited" ? (
        <p className="mt-2 text-(--term-muted)" role="status">
          {t("dashboard:agentRequests.declineSent")}
        </p>
      ) : null}
      {tab.decline === "unsent" && tab.phase !== "exited" ? (
        <p className="mt-2 text-amber-200" role="status">
          {t("dashboard:agentRequests.declineUnsent")}
        </p>
      ) : null}
      {tab.decline === "failed" && tab.phase !== "exited" ? (
        <p className="mt-2 text-amber-200" role="alert">
          {t("dashboard:agentRequests.declineFailed")}
        </p>
      ) : null}
      {tab.decline === "started" ? (
        <p className="mt-2 font-medium text-amber-200" role="status">
          {t("dashboard:agentRequests.startedBeforeDecline")}
        </p>
      ) : null}
      {finished ? <p className="mt-2 font-medium">{t(finished.key, finished.values)}</p> : null}
      <div className="mt-2 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
        {tab.phase === "waiting" ? (
          <button
            type="button"
            className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-md border border-(--term-border) px-3 text-sm text-(--term-fg) hover:bg-(--term-hover) focus-visible:outline-2 focus-visible:outline-ring"
            onClick={onView}
          >
            {t("dashboard:agentRequests.view")}
          </button>
        ) : null}
        {canToggle ? (
          <label
            htmlFor={checkboxId}
            className={cn(
              "flex min-h-11 items-center gap-3",
              tab.phase === "live" ? "cursor-pointer" : "cursor-not-allowed opacity-60",
            )}
          >
            <Checkbox
              id={checkboxId}
              checked={tab.reviewOutput === true}
              disabled={tab.phase !== "live"}
              onCheckedChange={(checked) => onReviewOutputChange(checked === true)}
            />
            <span>{t("dashboard:agentRequests.reviewOutput")}</span>
          </label>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Review of a supervised command's output before the agent gets any of it.
 * Closing (Esc, the close button, a tap outside) redacts everything; the
 * first submission from any viewer wins.
 */
export function ReviewOutputDialog({
  tab,
  onSettled,
}: {
  tab: TerminalTab;
  /** The review is over here: submitted, or already answered elsewhere. */
  onSettled: (localId: string) => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  const queryClient = useQueryClient();
  const capture = tab.reviewCapture;
  const commandId = tab.supervised?.commandId ?? "";
  const original = capture ? reviewCaptureText(capture) : "";
  const [text, setText] = useState(original);
  const submit = useMutation(
    orpc.supervisedCommands.submitOutput.mutationOptions({
      onSuccess: (result) => {
        toast.success(
          result.outputMode === "redacted"
            ? t("dashboard:agentRequests.review.redacted")
            : t("dashboard:agentRequests.review.sent"),
        );
        void queryClient.invalidateQueries({ queryKey: orpc.supervisedCommands.key() });
        onSettled(tab.localId);
      },
      onError: (error) => {
        if (isConflict(error) || isNotFound(error)) {
          // Another viewer answered first, or the review timed out (redacted).
          toast.info(t("dashboard:agentRequests.review.alreadyAnswered"));
          onSettled(tab.localId);
          return;
        }
        toast.error(t("dashboard:agentRequests.review.failed"));
      },
    }),
  );
  const send = (output: string | null) => {
    if (submit.isPending || !commandId) return;
    submit.mutate({ commandId, output, edited: output !== null && output !== original });
  };
  const textareaId = useId();
  return (
    <ResponsiveDialog
      open
      onOpenChange={(open) => {
        if (!open) send(null);
      }}
      title={t("dashboard:agentRequests.review.title")}
      description={t("dashboard:agentRequests.review.description", {
        requester: escapeForDisplay(tab.supervised?.requester ?? ""),
      })}
      className="sm:max-w-2xl"
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            size="touch"
            variant="outline"
            disabled={submit.isPending || text === original}
            onClick={() => setText(original)}
          >
            {t("dashboard:agentRequests.review.undo")}
          </Button>
          <Button
            type="button"
            size="touch"
            variant="outline"
            disabled={submit.isPending}
            onClick={() => send(text)}
          >
            {t("dashboard:agentRequests.review.submit")}
          </Button>
          <Button
            type="button"
            size="touch"
            // The default action: nothing leaves unless the person chooses to.
            autoFocus
            disabled={submit.isPending}
            onClick={() => send(null)}
          >
            {t("dashboard:agentRequests.review.redact")}
          </Button>
        </div>
      }
    >
      <div className="flex min-w-0 flex-col gap-2 pb-2">
        <label htmlFor={textareaId} className="text-sm font-medium">
          {t("dashboard:agentRequests.review.label")}
        </label>
        <Textarea
          id={textareaId}
          value={text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          className="max-h-[50svh] min-h-40 overflow-x-hidden overflow-y-auto overscroll-contain font-mono text-xs"
        />
        {capture && capture.totalBytes > capture.head.byteLength + capture.tail.byteLength ? (
          <p className="text-xs text-muted-foreground">
            {t("dashboard:agentRequests.review.truncated", { bytes: capture.totalBytes })}
          </p>
        ) : null}
      </div>
    </ResponsiveDialog>
  );
}
