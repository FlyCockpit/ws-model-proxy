import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { CircleCheck, LoaderCircle, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useNow } from "@/hooks/use-now";
import { orpc } from "@/utils/orpc";

import { CommandBlock, ConnectionBadge, formatGb } from "./node-badges";
import type { EnrollmentCode, EnrollmentResult } from "./node-types";

/** How often the panel looks for nodes that used the code. */
const POLL_MS = 3_000;

/** `m:ss` (or `h:mm:ss`) left until `expiresAt`; null once it passed. */
export function countdownText(expiresAt: string, now: number): string | null {
  const left = Math.floor((new Date(expiresAt).getTime() - now) / 1000);
  if (!(left > 0)) return null;
  const hours = Math.floor(left / 3600);
  const minutes = Math.floor((left % 3600) / 60);
  const seconds = String(left % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/**
 * The "Add a node" panel after a code is minted (Nodes → Add a node, Welcome step 1): the
 * one-liner with copy, a countdown, what happens on the machine, and the nodes that used the
 * code, turning green with name and hardware once they connect. `onNewCode` offers a fresh code.
 */
export function EnrollmentPanel({
  result,
  lang,
  onNewCode,
  newCodePending = false,
}: {
  result: EnrollmentResult;
  lang: string;
  onNewCode?: () => void;
  newCodePending?: boolean;
}) {
  const { t } = useTranslation(["dashboard"]);
  const codes = useQuery({
    ...orpc.nodes.enrollmentCodes.list.queryOptions(),
    refetchInterval: POLL_MS,
  });
  const code: EnrollmentCode =
    codes.data?.codes.find((candidate) => candidate.id === result.code.id) ?? result.code;
  const enrolled = code.enrolled;
  const usedUp = code.usedCount >= code.maxUses || code.revokedAt !== null;
  const now = useNow(1_000, !usedUp);
  const left = countdownText(code.expiresAt, now);
  return (
    <div className="min-w-0 space-y-4">
      <CommandBlock command={result.installCommand} label={t("dashboard:nodes.add.commandLabel")} />
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground" aria-live="off">
          {t("dashboard:nodes.add.secretOnce")}{" "}
          {usedUp
            ? null
            : left
              ? t("dashboard:nodes.add.expiresIn", { time: left })
              : t("dashboard:nodes.add.expired")}
          {code.maxUses > 1
            ? ` · ${t("dashboard:nodes.codes.uses", { used: code.usedCount, max: code.maxUses })}`
            : null}
        </p>
        {onNewCode ? (
          <Button
            type="button"
            variant="outline"
            size="touch"
            disabled={newCodePending}
            onClick={onNewCode}
          >
            <RefreshCw aria-hidden="true" />
            {t("dashboard:nodes.add.newCode")}
          </Button>
        ) : null}
      </div>
      <div className="min-w-0 space-y-1.5">
        <p className="text-sm font-medium">{t("dashboard:nodes.add.onMachine")}</p>
        <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
          <li>{t("dashboard:nodes.add.machineSteps.install")}</li>
          <li>{t("dashboard:nodes.add.machineSteps.login")}</li>
          <li>{t("dashboard:nodes.add.machineSteps.trust")}</li>
          <li>{t("dashboard:nodes.add.terminalsAsked")}</li>
          <li>{t("dashboard:nodes.add.machineSteps.service")}</li>
        </ol>
        <p className="text-xs text-muted-foreground">{t("dashboard:nodes.add.installsWhere")}</p>
      </div>
      {enrolled.length === 0 ? (
        <p className="flex items-center gap-2 text-sm" role="status">
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin text-muted-foreground" />
          {t("dashboard:nodes.add.waiting")}
        </p>
      ) : (
        <JoinedNodes enrolled={enrolled} lang={lang} />
      )}
    </div>
  );
}

/** Nodes that used the code: green with name and hardware once connected. */
function JoinedNodes({ enrolled, lang }: { enrolled: EnrollmentCode["enrolled"]; lang: string }) {
  const { t } = useTranslation(["dashboard"]);
  const nodes = useQuery({ ...orpc.nodes.list.queryOptions(), refetchInterval: POLL_MS });
  return (
    <ul className="space-y-2" role="status">
      {enrolled.map((use) => {
        const node = use.nodeId
          ? nodes.data?.nodes.find((candidate) => candidate.id === use.nodeId)
          : undefined;
        const online = node?.connection === "ONLINE";
        const gpus = node?.gpus.map((gpu) => gpu.name ?? gpu.vendor).join(", ");
        const free = node ? formatGb(node.liveFreeMemoryGb, lang) : null;
        return (
          <li
            key={`${use.nodeId}-${use.usedAt}`}
            data-online={online}
            className={cn(
              "min-w-0 space-y-1 rounded-md border p-3 text-sm",
              online && "border-state-success/40 bg-state-success-bg",
            )}
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-state-success" />
              {use.nodeId ? (
                <Link
                  to="/$lang/nodes/$nodeId"
                  params={{ lang, nodeId: use.nodeId }}
                  className="inline-flex min-h-[44px] min-w-0 items-center break-all underline"
                >
                  {t("dashboard:nodes.add.joined", {
                    slug: node?.name ?? node?.slug ?? use.slug ?? use.nodeId,
                  })}
                </Link>
              ) : (
                t("dashboard:nodes.add.joinedDeleted")
              )}
              {node ? <ConnectionBadge connection={node.connection} /> : null}
            </div>
            {node ? (
              <p className="text-xs text-muted-foreground">
                {node.hardwareKind
                  ? [t(`dashboard:nodes.hardwareKind.${node.hardwareKind}`), gpus, free]
                      .filter(Boolean)
                      .join(" · ")
                  : t("dashboard:nodes.add.readingHardware")}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
