import { useTranslation } from "react-i18next";

import { useNodeLive } from "@/stores/node-live";

/**
 * Says so once the node live updates stream has been down for a while (`NODE_LIVE_NOTICE_MS`);
 * nothing on the first connect or a brief drop. Pages poll at their old intervals meanwhile.
 */
export function LiveUpdatesNotice({ className }: { className?: string }) {
  const { t } = useTranslation(["dashboard"]);
  const notice = useNodeLive((state) => state.notice);
  if (!notice) return null;
  return (
    <p className={className ?? "text-sm text-muted-foreground"} role="status">
      {t("dashboard:liveUpdates.paused")}
    </p>
  );
}
