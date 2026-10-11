import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json";

/**
 * The fingerprint of a start or apply preview: sha256 of the canonical JSON of the preview
 * without its own `fingerprint` field and without `warnings`. A person applies exactly the
 * preview they confirmed (`preview_required` / `preview_stale`), so everything the apply would
 * do (starts, stops, kept instances, hold changes, refusals) is covered. Warnings are advice
 * that never changes what an apply does, and some follow live metrics (free memory): covering
 * them would make a near-threshold preview go stale on every click.
 */
export function previewFingerprint(preview: Record<string, unknown>): string {
  const { fingerprint: _fingerprint, warnings: _warnings, ...shown } = preview;
  return createHash("sha256").update(canonicalJson(shown), "utf8").digest("hex");
}
