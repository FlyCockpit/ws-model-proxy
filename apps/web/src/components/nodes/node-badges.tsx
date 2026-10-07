import { Button } from "@ws-model-proxy/ui/components/button";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { NodeSummary } from "./node-types";

type Tone = "success" | "warning" | "info" | "muted" | "destructive";

const DOT: Record<Tone, string> = {
  success: "bg-state-success",
  warning: "bg-state-warning",
  info: "bg-state-info",
  muted: "bg-muted-foreground",
  destructive: "bg-destructive",
};

/** Status is always text plus a dot, never colour alone. */
export function StatusPill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs whitespace-nowrap">
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", DOT[tone])} />
      {children}
    </span>
  );
}

export function ConnectionBadge({ connection }: { connection: NodeSummary["connection"] }) {
  const { t } = useTranslation(["dashboard"]);
  return connection === "ONLINE" ? (
    <StatusPill tone="success">{t("dashboard:nodes.status.online")}</StatusPill>
  ) : (
    <StatusPill tone="muted">{t("dashboard:nodes.status.offline")}</StatusPill>
  );
}

export function TrustBadge({ trust }: { trust: NodeSummary["trust"] }) {
  const { t } = useTranslation(["dashboard"]);
  if (trust.lowerPending)
    return <StatusPill tone="warning">{t("dashboard:nodes.trust.lowering")}</StatusPill>;
  if (trust.reported === null)
    return <StatusPill tone="muted">{t("dashboard:nodes.trust.unknown")}</StatusPill>;
  return trust.effective === "FULL" ? (
    <StatusPill tone="info">{t("dashboard:nodes.trust.full")}</StatusPill>
  ) : (
    <StatusPill tone="muted">{t("dashboard:nodes.trust.relay")}</StatusPill>
  );
}

export function NodeFlags({
  node,
}: {
  node: Pick<NodeSummary, "hold" | "rejectedProtocolVersion" | "removeAfterOfflineMs">;
}) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <>
      {node.hold ? (
        <StatusPill tone="warning">
          {node.hold.profileId
            ? t("dashboard:nodes.hold.byProfile")
            : t("dashboard:nodes.hold.badge")}
        </StatusPill>
      ) : null}
      {node.removeAfterOfflineMs !== null ? (
        <StatusPill tone="muted">{t("dashboard:nodes.temporary.badge")}</StatusPill>
      ) : null}
      {node.rejectedProtocolVersion ? (
        <StatusPill tone="destructive">{t("dashboard:nodes.status.upgrade")}</StatusPill>
      ) : null}
    </>
  );
}

/** A shell command with a copy button (44px target). */
export function CommandBlock({ command, label }: { command: string; label?: string }) {
  const { t } = useTranslation(["dashboard", "errors"]);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      toast.success(t("dashboard:nodes.copied"));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t("errors:couldNotCopy"));
    }
  };
  return (
    <div className="flex min-w-0 items-start gap-2 rounded-md border bg-muted/40 p-2">
      <code
        aria-label={label}
        className="min-w-0 flex-1 font-mono text-xs leading-relaxed break-all select-all"
      >
        {command}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon-touch"
        className="shrink-0"
        onClick={copy}
        aria-label={t("dashboard:nodes.copy")}
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </Button>
    </div>
  );
}

/** "12.5 GB" with at most one decimal. */
export function formatGb(value: number | null, lang: string): string | null {
  if (value === null) return null;
  return `${new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(value)} GB`;
}
