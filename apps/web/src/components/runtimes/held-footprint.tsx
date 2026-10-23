import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { useTranslation } from "react-i18next";

import { formatGb } from "@/components/nodes/node-badges";

type Instance = Awaited<ReturnType<AppRouterClient["runtimes"]["get"]>>["instanceList"][number];

/**
 * Everything else an instance's claim keeps held beside its parts' current ports: each part's
 * claim of the run a restart replaced (`previousClaim`, on the same node), and the memory held on
 * other nodes (`launch.reservations`), the current plan's and a replaced run's (superseded) that
 * still hold. Recovery dialogs show it so a person sees the whole footprint a release frees (or
 * that stays held). Nothing when there is none.
 */
export function HeldFootprint({
  instance,
  nodeNumber,
  heading,
  withReservations = true,
}: {
  instance: Instance;
  /** Only this part's previous claim (reservations belong to the whole instance). */
  nodeNumber?: number;
  heading: string;
  /** False: leave the reservations out (another part's claim keeps holding them). */
  withReservations?: boolean;
}) {
  const { t, i18n } = useTranslation(["dashboard"]);
  const memory = (gb: number) => formatGb(gb, i18n.language);
  const nodeName = (slug: string | null) => slug ?? t("dashboard:runtime.nodeGone");
  const previous = instance.ranks.flatMap((rank) =>
    rank.previousClaim && (nodeNumber === undefined || rank.nodeNumber === nodeNumber)
      ? [{ nodeNumber: rank.nodeNumber, node: rank.nodeSlug, claim: rank.previousClaim }]
      : [],
  );
  const holding = (reservation: Instance["reservations"][number]) =>
    reservation.reserved !== "RELEASED";
  const current = withReservations ? instance.reservations.filter(holding) : [];
  const superseded = withReservations ? instance.supersededReservations.filter(holding) : [];
  if (previous.length === 0 && current.length === 0 && superseded.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1 border-t pt-2">
      <p className="font-medium">{heading}</p>
      <ul className="flex min-w-0 flex-col gap-1">
        {previous.map((entry) => (
          <li key={`previous-${entry.nodeNumber}`} className="break-words">
            {t("dashboard:runtime.heldFootprint.previousClaim", {
              port: entry.claim.port,
              memory: memory(entry.claim.memoryGb),
              node: nodeName(entry.node),
            })}
          </li>
        ))}
        {current.map((reservation) => (
          <li key={`current-${reservation.index}`} className="break-words">
            {t("dashboard:runtime.heldFootprint.reservation", {
              memory: memory(reservation.memoryGb),
              node: nodeName(reservation.nodeSlug),
            })}
          </li>
        ))}
        {superseded.map((reservation, position) => (
          // A replaced run keeps at most one row per index; the position keeps keys unique anyway.
          <li key={`superseded-${reservation.index}-${position}`} className="break-words">
            {t("dashboard:runtime.heldFootprint.supersededReservation", {
              memory: memory(reservation.memoryGb),
              node: nodeName(reservation.nodeSlug),
            })}
          </li>
        ))}
      </ul>
    </div>
  );
}
