import { cn } from "@ws-model-proxy/ui/lib/utils";
import { useTranslation } from "react-i18next";

import { TimeAgo } from "@/components/time-ago";

export type CredentialDates = {
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
};

export type CredentialStatus = "active" | "expired" | "revoked";

export function credentialStatus(row: CredentialDates, now: number): CredentialStatus {
  if (row.revokedAt) return "revoked";
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= now) return "expired";
  return "active";
}

export function CredentialStatusBadge({ status }: { status: CredentialStatus }) {
  const { t } = useTranslation(["access"]);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs",
        status === "active"
          ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-400"
          : "text-muted-foreground",
      )}
    >
      {t(`access:status.${status}`)}
    </span>
  );
}

/** Created / last used / expires, as a compact definition list. */
export function CredentialDatesList({ row }: { row: CredentialDates }) {
  const { t } = useTranslation(["access"]);
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
      <dt>{t("access:fields.created")}</dt>
      <dd>
        <TimeAgo value={row.createdAt} />
      </dd>
      <dt>{t("access:fields.lastUsed")}</dt>
      <dd>{row.lastUsedAt ? <TimeAgo value={row.lastUsedAt} /> : t("access:fields.neverUsed")}</dd>
      <dt>{t("access:fields.expiry")}</dt>
      <dd>{row.expiresAt ? <TimeAgo value={row.expiresAt} /> : t("access:fields.never")}</dd>
    </dl>
  );
}

export const EXPIRY_CHOICES = ["d7", "d30", "d90", "y1", "never"] as const;
export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number];

const EXPIRY_DAYS: Record<Exclude<ExpiryChoice, "never">, number> = {
  d7: 7,
  d30: 30,
  d90: 90,
  y1: 364,
};

/** The ISO expiry for a choice (a year is 364 days so it stays inside the server's cap). */
export function expiryFromChoice(choice: ExpiryChoice, now: number): string | null {
  if (choice === "never") return null;
  return new Date(now + EXPIRY_DAYS[choice] * 86_400_000).toISOString();
}
