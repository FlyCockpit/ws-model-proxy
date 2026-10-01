/** Per-capacity text-only estimate calibration. Prompt-free: ratios only. */

export const CALIBRATION_WINDOW = 200;
export const CALIBRATION_MIN_SAMPLES = 20;
export const CALIBRATION_CLAMP_MIN = 0.3;
export const CALIBRATION_CLAMP_MAX = 1.5;

export type CalibrationIdentity = {
  runtimeIdentityKey?: string | null;
  runtimeModel?: string | null;
  runtimeRevision?: string | null;
};

type Slot = { identity: string; ratios: number[] };

const slots = new Map<string, Slot>();

function identityKey(identity: CalibrationIdentity): string {
  return `${identity.runtimeIdentityKey ?? ""}\0${identity.runtimeModel ?? ""}\0${identity.runtimeRevision ?? ""}`;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 1;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index]!;
}

function scaledTokens(
  capacityId: string,
  identity: CalibrationIdentity,
  rawTokens: number,
  q: number,
): number | null {
  if (!capacityId || !Number.isFinite(rawTokens) || rawTokens < 0) return null;
  const slot = slots.get(capacityId);
  if (
    !slot ||
    slot.identity !== identityKey(identity) ||
    slot.ratios.length < CALIBRATION_MIN_SAMPLES
  )
    return null;
  const factor = quantile(
    [...slot.ratios].sort((left, right) => left - right),
    q,
  );
  const unclamped = Math.ceil(rawTokens * factor);
  const lo = Math.ceil(rawTokens * CALIBRATION_CLAMP_MIN);
  const hi = Math.ceil(rawTokens * CALIBRATION_CLAMP_MAX);
  return Math.min(hi, Math.max(lo, unclamped));
}

export function resetContextCalibrationForTests(): void {
  slots.clear();
}

export function observeContextCalibration({
  capacityId,
  identity,
  textEstimate,
  promptTokens,
  mediaParts,
}: {
  capacityId: string;
  identity: CalibrationIdentity;
  textEstimate: number;
  promptTokens: number;
  mediaParts: number;
}): void {
  if (!capacityId || mediaParts > 0) return;
  if (!Number.isFinite(textEstimate) || textEstimate <= 0) return;
  if (!Number.isFinite(promptTokens) || promptTokens < 0) return;
  const ratio = promptTokens / textEstimate;
  if (!Number.isFinite(ratio) || ratio <= 0) return;
  const key = identityKey(identity);
  let slot = slots.get(capacityId);
  if (!slot || slot.identity !== key) {
    slot = { identity: key, ratios: [] };
    slots.set(capacityId, slot);
  }
  slot.ratios.push(ratio);
  if (slot.ratios.length > CALIBRATION_WINDOW) slot.ratios.shift();
}

/** 95th-percentile scale for context-limit checks. Null until warm. */
export function calibratedContextTokens(
  capacityId: string,
  identity: CalibrationIdentity,
  rawTokens: number,
): number | null {
  return scaledTokens(capacityId, identity, rawTokens, 0.95);
}

/** Median scale for warm footprints when the engine did not report tokens. */
export function calibratedFootprintTokens(
  capacityId: string,
  identity: CalibrationIdentity,
  rawTokens: number,
): number | null {
  return scaledTokens(capacityId, identity, rawTokens, 0.5);
}
