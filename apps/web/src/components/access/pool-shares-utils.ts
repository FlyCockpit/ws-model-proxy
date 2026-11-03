import { toast } from "@ws-model-proxy/ui/lib/toast";

import type { InviteLink, ShareView } from "./pool-shares";

export const PRIORITY_CHOICES = ["POOL", "BACKGROUND", "NORMAL", "HIGH"] as const;
export type PriorityChoice = (typeof PRIORITY_CHOICES)[number];

/** What a share or invite answer tells the owner: shared, e-mailed, or a link to copy. */
export function announceShared(
  result:
    | { kind: "share" }
    | { kind: "invite"; invite: { expiresAt: string }; link: string | null },
  email: string,
  t: (key: string, options?: Record<string, unknown>) => string,
  onLink: (link: InviteLink) => void,
) {
  if (result.kind === "share") toast.success(t("access:shares.shared", { email }));
  else if (result.link) onLink({ email, link: result.link, expiresAt: result.invite.expiresAt });
  else toast.success(t("access:shares.invited", { email }));
}

export function priorityLabel(
  t: (key: string) => string,
  priority: ShareView["priorityClass"] | PriorityChoice,
) {
  switch (priority) {
    case null:
    case "POOL":
      return t("access:shares.priorityPool");
    case "BACKGROUND":
      return t("access:shares.priorityBackground");
    case "NORMAL":
      return t("access:shares.priorityNormal");
    case "HIGH":
      return t("access:shares.priorityHigh");
  }
}

export function priorityItems(t: (key: string) => string) {
  return PRIORITY_CHOICES.map((value) => ({ value, label: priorityLabel(t, value) }));
}
