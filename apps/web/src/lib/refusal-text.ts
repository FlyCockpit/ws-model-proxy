import i18n, { type TFunction } from "i18next";

import { friendly } from "@/utils/friendly-error";

/** The `data.reason` of an oRPC refusal (contracts/refusals.ts), when there is one. */
export function refusalReason(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("data" in error)) return null;
  const data = (error as { data: unknown }).data;
  if (typeof data !== "object" || data === null || !("reason" in data)) return null;
  const reason = (data as { reason: unknown }).reason;
  return typeof reason === "string" && /^[a-z_]{1,64}$/.test(reason) ? reason : null;
}

/** The `launch.reservations` entry a placement refusal is about (contracts/refusals.ts). */
export type RefusalReservation = { index: number; labels: string[]; nodeSlug: string | null };

/**
 * The reservation of a refusal: a preview's refusal (`reservation`) or an oRPC error
 * (`data.reservation`). Checked field by field (it is shown, never trusted as a shape).
 */
export function refusalReservationOf(value: unknown): RefusalReservation | null {
  if (typeof value !== "object" || value === null) return null;
  const data = "data" in value ? Reflect.get(value, "data") : value;
  if (typeof data !== "object" || data === null) return null;
  const reservation = Reflect.get(data, "reservation");
  if (typeof reservation !== "object" || reservation === null) return null;
  const index = Reflect.get(reservation, "index");
  const labels = Reflect.get(reservation, "labels");
  const nodeSlug = Reflect.get(reservation, "nodeSlug");
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return null;
  if (!Array.isArray(labels) || !labels.every((label) => typeof label === "string")) return null;
  return {
    index,
    labels: labels as string[],
    nodeSlug: typeof nodeSlug === "string" ? nodeSlug : null,
  };
}

/** `reason` (localized copy) with the reservation it is about, when there is one. */
export function withReservation(
  t: TFunction,
  reservation: RefusalReservation | null,
  reason: string,
): string {
  if (!reservation) return reason;
  const values = {
    number: reservation.index + 1,
    labels: reservation.labels.join(", "),
    node: reservation.nodeSlug ?? "",
    reason,
  };
  return reservation.nodeSlug
    ? t("dashboard:runtime.reservationRefusalNode", values)
    : t("dashboard:runtime.reservationRefusal", values);
}

/**
 * Localized copy for a runtime/pool refusal (`dashboard:runtime.refusals.<reason>`), else the
 * generic friendly copy; a reservation's refusal says which reservation. Never shows a server
 * message verbatim.
 */
export function refusalText(error: unknown, fallback?: string): string {
  const reason = refusalReason(error);
  const key = `dashboard:runtime.refusals.${reason}`;
  if (reason && i18n.exists(key))
    return withReservation(i18n.t, refusalReservationOf(error), i18n.t(key));
  return friendly(error, fallback);
}

/**
 * An automatic restart that waits for room (STOPPED, `phaseReason` `waiting_<refusal reason>`,
 * retried every 30 seconds): why, from the refusal's localized copy, or neutral copy for a
 * reason without one. Null when the instance is not waiting.
 */
export function waitingToRestartText(
  t: TFunction,
  instance: { phase: string; phaseReason: string | null },
): string | null {
  const reasonCode = instance.phaseReason?.startsWith("waiting_")
    ? instance.phaseReason.slice("waiting_".length)
    : null;
  if (instance.phase !== "STOPPED" || !reasonCode) return null;
  const key = `dashboard:runtime.refusals.${reasonCode}`;
  const reason = /^[a-z_]{1,64}$/.test(reasonCode) ? t(key, { defaultValue: "" }) : "";
  return reason && reason !== key
    ? t("dashboard:runtime.waitingToRestart", { reason })
    : t("dashboard:runtime.waitingToRestartNeutral");
}
