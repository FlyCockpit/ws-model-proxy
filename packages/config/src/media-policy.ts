/**
 * Shared media policy for WS Model Proxy.
 *
 * Lives in `@ws-model-proxy/config` so the server media store, oRPC settings,
 * web chat-test composer, and (conceptually) the CLI media expander enforce
 * the same bounds and image-format rules without cross-app imports.
 *
 * ## Image format strategy (long-term)
 *
 * Transport paths differ:
 * - **Base64 / data URLs in chat bodies** (minimal deploy, offline local models):
 *   emit only model-inline-safe formats (JPEG/PNG). Many local OpenAI-compatible
 *   servers (LM Studio, llama.cpp) reject WebP/GIF with opaque 400s.
 * - **Signed media URLs** (media store on): storage may keep the original
 *   container; consumers that cannot fetch URLs use CLI `expandMedia`, which
 *   normalizes images to JPEG/PNG when inlining.
 * - **External https URLs**: left alone (not our encode problem).
 *
 * Encode decisions prefer passthrough of already-safe JPEG/PNG under size/edge
 * limits. When re-encoding, callers try an ordered list of target mimes and keep
 * the first result that fits the byte budget — PNG may be preferred for
 * screenshots, but JPEG is always the acceptance fallback so large PNGs are not
 * rejected when a lossy encode would fit. See `decideImageEncode`.
 */

// ---------------------------------------------------------------------------
// Asset TTL (unchanged contract)
// ---------------------------------------------------------------------------

export const MEDIA_ASSET_TTL_HOURS_SETTING_KEY = "mediaAssetTtlHours";

export const MEDIA_ASSET_TTL_DEFAULT_HOURS = 24;
export const MEDIA_ASSET_TTL_MIN_HOURS = 1;
export const MEDIA_ASSET_TTL_MAX_HOURS = 168; // 7 days

/** Admin-set global attachment cap. Deployment upload limits remain a hard ceiling. */
export const MEDIA_ATTACHMENT_MAX_BYTES_SETTING_KEY = "mediaAttachmentMaxBytes";
export const MEDIA_ATTACHMENT_MAX_BYTES_DEFAULT = 25 * 1024 * 1024;
export const MEDIA_ATTACHMENT_MAX_BYTES_MIN = 256 * 1024;
export const MEDIA_ATTACHMENT_MAX_BYTES_MAX = 2 ** 31 - 1;

export function clampMediaAttachmentMaxBytes(value: number): number {
  if (!Number.isFinite(value)) return MEDIA_ATTACHMENT_MAX_BYTES_DEFAULT;
  return Math.min(
    MEDIA_ATTACHMENT_MAX_BYTES_MAX,
    Math.max(MEDIA_ATTACHMENT_MAX_BYTES_MIN, Math.trunc(value)),
  );
}

/** Clamp an arbitrary hours value into the safe range; NaN/invalid -> default. */
export function clampMediaAssetTtlHours(value: number): number {
  if (!Number.isFinite(value)) return MEDIA_ASSET_TTL_DEFAULT_HOURS;
  return Math.min(
    MEDIA_ASSET_TTL_MAX_HOURS,
    Math.max(MEDIA_ASSET_TTL_MIN_HOURS, Math.trunc(value)),
  );
}

// ---------------------------------------------------------------------------
// Image formats for multimodal chat payloads
// ---------------------------------------------------------------------------

/**
 * Formats safe to embed as `data:` URLs (or expand into data URLs) for the
 * widest set of local OpenAI-compatible vision servers.
 *
 * `image/jpg` is accepted as input via {@link normalizeImageMime} (aliased to
 * `image/jpeg`); the canonical safe list only names `image/jpeg`.
 */
export const MODEL_INLINE_SAFE_IMAGE_MIMES = ["image/jpeg", "image/png"] as const;

export type ModelInlineSafeImageMime = (typeof MODEL_INLINE_SAFE_IMAGE_MIMES)[number];

/**
 * Formats the chat-test / browser composer accepts as *input* (before encode).
 * Output for the model-inline-safe profile is always JPEG or PNG.
 */
export const CLIENT_ACCEPTED_IMAGE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export type ClientAcceptedImageMime = (typeof CLIENT_ACCEPTED_IMAGE_MIMES)[number];

// ---------------------------------------------------------------------------
// Browser media-input catalog
// ---------------------------------------------------------------------------
// This catalog describes media containers the browser may offer for chat input.
// It intentionally does not inspect bytes; server media storage remains the
// authority that validates uploaded content with magic-byte sniffing.

export type MediaInputModality = "image" | "audio" | "video";

export const CLIENT_ACCEPTED_AUDIO_MIMES = [
  "audio/mpeg",
  "audio/wav",
  "audio/flac",
  "audio/ogg",
  "audio/mp4",
] as const;

export const CLIENT_ACCEPTED_VIDEO_MIMES = [
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-matroska",
] as const;

export const CLIENT_ACCEPTED_MEDIA_MIMES = [
  ...CLIENT_ACCEPTED_IMAGE_MIMES,
  ...CLIENT_ACCEPTED_AUDIO_MIMES,
  ...CLIENT_ACCEPTED_VIDEO_MIMES,
] as const;

export type ClientAcceptedMediaMime = (typeof CLIENT_ACCEPTED_MEDIA_MIMES)[number];

const modalityByCanonicalMediaMime: Record<ClientAcceptedMediaMime, MediaInputModality> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
  "image/gif": "image",
  "audio/mpeg": "audio",
  "audio/wav": "audio",
  "audio/flac": "audio",
  "audio/ogg": "audio",
  "audio/mp4": "audio",
  "video/mp4": "video",
  "video/webm": "video",
  "video/quicktime": "video",
  "video/x-matroska": "video",
};

/** Vendor/browser MIME aliases mapped to the canonical media catalog. */
export const MEDIA_MIME_ALIASES: Record<string, ClientAcceptedMediaMime> = {
  "image/jpg": "image/jpeg",
  "audio/mp3": "audio/mpeg",
  "audio/x-mpeg": "audio/mpeg",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/x-flac": "audio/flac",
  "application/ogg": "audio/ogg",
  "audio/opus": "audio/ogg",
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "video/x-m4v": "video/mp4",
  "application/x-matroska": "video/x-matroska",
};

/** Supported filename extensions mapped to the canonical media catalog. */
export const MEDIA_EXTENSION_MIME_MAP: Record<string, ClientAcceptedMediaMime> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/mp4",
  ".m4b": "audio/mp4",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
};

export type MediaInputModalities = Record<MediaInputModality, boolean>;
export type MediaInputInfo = { modality: MediaInputModality; mime: ClientAcceptedMediaMime };

/** Normalize parameters/case and browser MIME aliases to a canonical MIME. */
export function normalizeMediaMime(mime: string): string {
  const base = mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return MEDIA_MIME_ALIASES[base] ?? base;
}

export function mediaModalityForMime(mime: string): MediaInputModality | null {
  const normalized = normalizeMediaMime(mime);
  return modalityByCanonicalMediaMime[normalized as ClientAcceptedMediaMime] ?? null;
}

export function isClientAcceptedMediaMime(mime: string): mime is ClientAcceptedMediaMime {
  return mediaModalityForMime(mime) !== null;
}

function extensionForFileName(name: string): string | null {
  const match = /\.[^.]+$/.exec(name.trim().toLowerCase());
  return match?.[0] ?? null;
}

/**
 * Classify a browser-selected file without relying solely on its declared MIME.
 * WebKit can return an empty or vendor-specific type; ISO-BMFF M4A/M4B files
 * also sometimes arrive as generic video/mp4, so their audio extension wins.
 */
export function mediaInputInfo({
  name,
  type,
}: {
  name: string;
  type: string;
}): MediaInputInfo | null {
  const extensionMime = MEDIA_EXTENSION_MIME_MAP[extensionForFileName(name) ?? ""];
  const declaredMime = normalizeMediaMime(type);
  if (declaredMime === "video/mp4" && extensionMime === "audio/mp4") {
    return { modality: "audio", mime: "audio/mp4" };
  }
  const declaredModality = mediaModalityForMime(declaredMime);
  if (declaredModality) {
    return { modality: declaredModality, mime: declaredMime as ClientAcceptedMediaMime };
  }
  if (!extensionMime) return null;
  return { modality: modalityByCanonicalMediaMime[extensionMime], mime: extensionMime };
}

/** Explicit media picker filter; extensions are included for iOS WebKit. */
export function acceptedMediaInputAcceptAttr(modalities: MediaInputModalities): string {
  const supports = (mime: ClientAcceptedMediaMime) =>
    modalities[modalityByCanonicalMediaMime[mime]];
  return [
    ...CLIENT_ACCEPTED_MEDIA_MIMES.filter(supports),
    ...Object.keys(MEDIA_MIME_ALIASES).filter((alias) => supports(MEDIA_MIME_ALIASES[alias]!)),
    ...Object.keys(MEDIA_EXTENSION_MIME_MAP).filter((extension) =>
      supports(MEDIA_EXTENSION_MIME_MAP[extension]!),
    ),
  ].join(",");
}

/**
 * Formats commonly accepted by cloud OpenAI-compatible vision APIs as data URLs.
 * Not used as the product default — local-first relay targets are narrower.
 */
export const OPENAI_BROAD_IMAGE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

/**
 * Which allowlist governs passthrough vs re-encode for model payloads.
 *
 * - `model-inline-safe` (default): only JPEG/PNG may pass through or be emitted.
 *   Correct for local LM Studio / llama.cpp-class servers.
 * - `openai-broad`: also allow WebP/GIF passthrough when under size/edge limits.
 *   Use only when the selected upstream is known to accept those formats.
 */
export type ImageInlineProfile = "model-inline-safe" | "openai-broad";

export const DEFAULT_IMAGE_INLINE_PROFILE: ImageInlineProfile = "model-inline-safe";

/** Longest edge guidance for client-side downscale (asset plan). */
export const DEFAULT_IMAGE_MAX_EDGE = 2048;

/** Lossy re-encode quality for JPEG (and WebP if a future profile emits it). */
export const DEFAULT_IMAGE_ENCODE_QUALITY = 0.85;

export function isModelInlineSafeImageMime(mime: string): mime is ModelInlineSafeImageMime {
  return (MODEL_INLINE_SAFE_IMAGE_MIMES as readonly string[]).includes(normalizeImageMime(mime));
}

export function isClientAcceptedImageMime(mime: string): mime is ClientAcceptedImageMime {
  const normalized = normalizeImageMime(mime);
  // normalizeImageMime maps image/jpg → image/jpeg; jpeg is accepted as input.
  return (CLIENT_ACCEPTED_IMAGE_MIMES as readonly string[]).includes(normalized);
}

/**
 * Strip parameters (`image/jpeg; charset=binary` → `image/jpeg`), lowercase, and
 * alias `image/jpg` → `image/jpeg` so TS and CLI safe-list checks stay aligned.
 */
export function normalizeImageMime(mime: string): string {
  return normalizeMediaMime(mime);
}

export type ImageEncodeDecision =
  | { action: "passthrough" }
  | {
      action: "reencode";
      /**
       * Ordered encode targets. Callers try each in order and keep the first
       * result under the byte budget. JPEG is always last when PNG is preferred
       * so large PNGs can still be accepted via lossy compression.
       */
      mimes: readonly ModelInlineSafeImageMime[];
    };

export type DecideImageEncodeInput = {
  sourceMime: string;
  width: number;
  height: number;
  /** Decoded binary byte size of the source (file size or data-URL payload). */
  byteSize: number;
  maxEdge?: number;
  maxBytes?: number;
  profile?: ImageInlineProfile;
};

/**
 * Decide whether an image can be embedded as-is or must be re-encoded before
 * going into an OpenAI-shaped `image_url` part.
 *
 * Pure function: no I/O. Callers still perform decode/canvas work when
 * `action === "reencode"`, trying `mimes` in order until one fits `maxBytes`.
 *
 * Priority (product: fit + work for local vision):
 * 1. Passthrough JPEG/PNG under edge and byte budgets.
 * 2. PNG sources: try PNG first when under the *source* byte budget (resize-only
 *    sharpness), then always fall back to JPEG if the PNG result is still large
 *    or the source was already over budget.
 * 3. Everything else → JPEG only.
 */
export function decideImageEncode(input: DecideImageEncodeInput): ImageEncodeDecision {
  const maxEdge = input.maxEdge ?? DEFAULT_IMAGE_MAX_EDGE;
  const maxBytes = input.maxBytes ?? Number.POSITIVE_INFINITY;
  const profile = input.profile ?? DEFAULT_IMAGE_INLINE_PROFILE;
  const mime = normalizeImageMime(input.sourceMime);
  const withinEdge =
    Number.isFinite(input.width) &&
    Number.isFinite(input.height) &&
    input.width > 0 &&
    input.height > 0 &&
    Math.max(input.width, input.height) <= maxEdge;
  const withinBytes =
    Number.isFinite(input.byteSize) && input.byteSize > 0 && input.byteSize <= maxBytes;

  if (withinEdge && withinBytes && mayPassthroughMime(mime, profile)) {
    return { action: "passthrough" };
  }

  return { action: "reencode", mimes: reencodeMimeChain(mime, withinBytes) };
}

/**
 * Build the ordered re-encode chain.
 *
 * - PNG under the source byte budget: try PNG (sharp UI screenshots after resize),
 *   then JPEG so a still-large PNG result does not hard-fail.
 * - PNG already over the byte budget: JPEG only (PNG re-encode rarely saves enough).
 * - All other sources: JPEG only (local-server safe + size).
 */
export function reencodeMimeChain(
  sourceMime: string,
  sourceWithinBytes: boolean,
): readonly ModelInlineSafeImageMime[] {
  const mime = normalizeImageMime(sourceMime);
  if (mime === "image/png" && sourceWithinBytes) {
    return ["image/png", "image/jpeg"];
  }
  return ["image/jpeg"];
}

function mayPassthroughMime(mime: string, profile: ImageInlineProfile): boolean {
  if (profile === "openai-broad") {
    return (OPENAI_BROAD_IMAGE_MIMES as readonly string[]).includes(mime);
  }
  return isModelInlineSafeImageMime(mime);
}

/**
 * Whether bytes with this Content-Type should be re-encoded when the CLI
 * expands a signed media URL into a `data:` URL for a local upstream.
 * Video/audio are not converted here — only still images.
 *
 * Keep in sync with CLI `is_model_inline_safe_image_mime` in apps/cli/src/media.rs
 * (Rust cannot import this package; both treat JPEG/PNG as safe and alias jpg).
 */
export function imageNeedsInlineNormalization(mime: string): boolean {
  const normalized = normalizeImageMime(mime);
  if (!normalized.startsWith("image/")) return false;
  return !isModelInlineSafeImageMime(normalized);
}
