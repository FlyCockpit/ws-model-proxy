import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json";

/**
 * The fingerprint of a start or apply preview: sha256 of the canonical JSON of the preview
 * without its own `fingerprint` field. A person applies exactly the preview they confirmed
 * (`preview_required` / `preview_stale`), so every field the preview shows (starts, stops,
 * kept instances, hold changes, warnings, refusals) is covered.
 */
export function previewFingerprint(preview: Record<string, unknown>): string {
  const { fingerprint: _ignored, ...shown } = preview;
  return createHash("sha256").update(canonicalJson(shown), "utf8").digest("hex");
}
