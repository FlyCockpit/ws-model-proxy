import { useInfiniteQuery } from "@tanstack/react-query";
import { escapeForDisplay } from "@ws-model-proxy/config/display-escape";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { orpc } from "@/utils/orpc";

const PAGE_SIZE = 20;
const COMMAND_KINDS: ReadonlySet<string> = new Set(["command", "supervised_command"]);
const KIND_KEYS = new Set([
  "command",
  "supervised_command",
  "file_read",
  "file_stat",
  "file_list",
  "file_search",
  "file_edit",
  "file_write",
  "file_rename",
  "file_mkdir",
  "file_delete",
  "supervised_file_write",
]);
const OUTCOME_KEYS = new Set([
  "completed",
  "refused",
  "failed",
  "cancelled",
  "declined",
  "expired",
  "unknown",
]);

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

/** A command's `path` is `sha256:<hex> <program>`; a file's is the path. */
export function splitAuditPath(kind: string, path: string): { hash: string | null; text: string } {
  if (COMMAND_KINDS.has(kind)) {
    const match = /^sha256:([0-9a-f]{64}) ?([\s\S]*)$/.exec(path);
    if (match) return { hash: (match[1] ?? "").slice(0, 12), text: match[2] ?? "" };
  }
  return { hash: null, text: path };
}

/**
 * Agent activity of one CLI device: what MCP agents did there (commands and
 * file operations), metadata only. Collapsed by default so the CLIs page does
 * not read every device's log; the first open loads the newest page.
 */
export function CliAgentActivity({
  cliDeviceId,
  deviceName,
}: {
  cliDeviceId: string;
  deviceName: string;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const query = useInfiniteQuery({
    ...orpc.cliAgentActivity.list.infiniteOptions({
      input: (cursor: string | undefined) => ({
        cliDeviceId,
        limit: PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
    enabled: open,
    retry: false,
  });
  const events = query.data?.pages.flatMap((page) => page.events) ?? [];

  return (
    <section className="border-t" aria-label={t("clis.activity.title")}>
      <Button
        type="button"
        variant="ghost"
        size="touch"
        className="w-full justify-start gap-2 rounded-none px-4"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={t(open ? "clis.activity.hide" : "clis.activity.show", { name: deviceName })}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        <span className="text-sm font-medium">{t("clis.activity.title")}</span>
      </Button>
      <div id={panelId} hidden={!open} className="min-w-0 px-4 pb-4">
        {open ? (
          <>
            <p className="mb-3 text-xs text-muted-foreground">{t("clis.activity.description")}</p>
            {query.isPending ? (
              <div className="space-y-2" aria-busy="true">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : query.isError ? (
              <div
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm"
              >
                <p className="font-medium text-destructive">{t("clis.activity.loadFailed")}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="touch"
                  className="mt-2"
                  onClick={() => void query.refetch()}
                >
                  {t("common:actions.tryAgain")}
                </Button>
              </div>
            ) : events.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">{t("clis.activity.empty")}</p>
            ) : (
              <>
                <ul
                  className="divide-y rounded-md border"
                  aria-label={t("clis.activity.listLabel", { name: deviceName })}
                >
                  {events.map((event) => {
                    const { hash, text } = splitAuditPath(event.kind, event.path);
                    return (
                      <li key={event.id} className="min-w-0 space-y-1 p-3 text-sm">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="font-medium">
                            {KIND_KEYS.has(event.kind)
                              ? t(`clis.activity.kinds.${event.kind}`)
                              : event.kind}
                          </span>
                          <span className="rounded-full border px-2 py-0.5 text-xs">
                            {OUTCOME_KEYS.has(event.outcome)
                              ? t(`clis.activity.outcomes.${event.outcome}`)
                              : event.outcome}
                          </span>
                          <time
                            className="text-xs text-muted-foreground"
                            dateTime={new Date(event.startedAt).toISOString()}
                          >
                            {dateTimeFormatter.format(new Date(event.startedAt))}
                          </time>
                        </div>
                        <p className="min-w-0 max-w-full whitespace-pre-wrap break-all font-mono text-xs">
                          {hash !== null
                            ? t("clis.activity.program", { value: escapeForDisplay(text) })
                            : escapeForDisplay(text)}
                        </p>
                        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          {hash !== null ? (
                            <span className="font-mono">
                              {t("clis.activity.commandHash", { value: hash })}
                            </span>
                          ) : null}
                          {event.reason ? (
                            <span>
                              {t("clis.activity.reason", { value: escapeForDisplay(event.reason) })}
                            </span>
                          ) : null}
                          {event.bytes !== null ? (
                            <span>
                              {t("clis.activity.bytes", { value: event.bytes.toLocaleString() })}
                            </span>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {query.hasNextPage ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="touch"
                    className="mt-3"
                    disabled={query.isFetchingNextPage}
                    onClick={() => void query.fetchNextPage()}
                  >
                    {query.isFetchingNextPage
                      ? t("clis.activity.loadingMore")
                      : t("clis.activity.loadMore")}
                  </Button>
                ) : null}
              </>
            )}
          </>
        ) : null}
      </div>
    </section>
  );
}
