// Client-side image attachment helpers for the chat-test composer.
//
// Multimodal encode policy lives in `@ws-model-proxy/config/media-policy`.
// This module performs browser I/O (decode, canvas, FileReader) and applies
// that pure policy so model payloads stay compatible with local vision servers.
//
// Size budget rationale (see asset-plan.md "Size limits"):
//   - The internal chat-test route enforces a global 10 MB Hono body limit.
//   - The CLI relay streams request bodies; the 10 MB internal route body limit
//     is the remaining ceiling for base64-through-relay.
//   - Multi-turn history RE-SENDS every prior image as base64 each turn.
// So we keep a conservative per-image cap and a total-request budget that both
// sit safely below that 10 MB route limit.

import {
  CLIENT_ACCEPTED_IMAGE_MIMES,
  DEFAULT_IMAGE_ENCODE_QUALITY,
  DEFAULT_IMAGE_INLINE_PROFILE,
  DEFAULT_IMAGE_MAX_EDGE,
  decideImageEncode,
  type ImageInlineProfile,
  isClientAcceptedImageMime,
  type ModelInlineSafeImageMime,
  reencodeMimeChain,
} from "@ws-model-proxy/config/media-policy";

export const ACCEPTED_IMAGE_TYPES = CLIENT_ACCEPTED_IMAGE_MIMES;

export const ACCEPTED_IMAGE_ACCEPT_ATTR = ACCEPTED_IMAGE_TYPES.join(",");

/** Longest edge after downscaling; matches the shared media-policy default. */
export const MAX_IMAGE_EDGE = DEFAULT_IMAGE_MAX_EDGE;

/** Re-encode quality for lossy JPEG output. */
export const IMAGE_ENCODE_QUALITY = DEFAULT_IMAGE_ENCODE_QUALITY;

/** Max number of images that may be attached to a single composer message. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;

// Post-compression per-image cap (decoded binary bytes, i.e. excluding the
// base64/data-URL overhead). Kept small because history re-sends each image.
export const PER_IMAGE_MAX_BYTES = 2 * 1024 * 1024; // ~2 MB

// Soft warning threshold for the estimated total request body (JSON incl. all
// base64 images across the whole thread). Warn as we approach the route limit.
export const TOTAL_REQUEST_SOFT_WARN_BYTES = 8 * 1024 * 1024; // ~8 MB

// Hard block: never send a request whose estimated body could exceed the
// internal chat-test route's 10 MB Hono body limit. We stop below it to leave
// headroom for JSON framing and non-image message content.
export const TOTAL_REQUEST_HARD_MAX_BYTES = 9.5 * 1024 * 1024; // ~9.5 MB

// Post-compression size at/below which we keep the Phase 0 base64 path even when
// media upload is available. Small images stay embedded (offline-friendly,
// fewer round trips); anything larger is uploaded so history stops re-sending
// multi-hundred-KB base64 each turn. (Phase 1 / decision 3B of asset-plan.md.)
export const UPLOAD_THRESHOLD_BYTES = 256 * 1024; // ~256 KB

export type ProcessedImage = {
  id: string;
  dataUrl: string;
  name: string;
  // Decoded (binary) byte size of the embedded image, post-compression.
  byteSize: number;
};

export type ProcessImageResult =
  | { ok: true; image: ProcessedImage }
  | { ok: false; reason: "unsupported" | "oversize" | "decodeFailed"; name: string };

export type ProcessImageOptions = {
  /**
   * Encode profile for the model payload. Defaults to `model-inline-safe`
   * (JPEG/PNG only) so local OpenAI-compatible servers accept the data URL.
   * Pass `openai-broad` only when the selected upstream is known to accept
   * WebP/GIF (e.g. cloud OpenAI-compatible APIs).
   */
  profile?: ImageInlineProfile;
};

export function isAcceptedImageType(type: string): boolean {
  return isClientAcceptedImageMime(type);
}

// Convert a processed base64 `data:` URL back into a Blob for multipart upload.
// Used when an attachment is large enough to prefer the media-store path over
// base64 embedding; the same bytes then back both the upload and a preview URL.
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  const header = dataUrl.slice(0, comma);
  const mimeMatch = /data:([^;,]+)/.exec(header);
  const mime = mimeMatch?.[1] ?? "application/octet-stream";
  const base64 = dataUrl.slice(comma + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// Decoded byte size of a base64 `data:` URL payload (excludes the header).
export function dataUrlByteSize(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return 0;
  const base64 = dataUrl.slice(comma + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function newAttachmentId(): string {
  return `img_${crypto.randomUUID().replaceAll("-", "_")}`;
}

function scaleWithin(width: number, height: number, maxEdge: number) {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const ratio = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(new Error("readFailed"));
    reader.readAsDataURL(file);
  });
}

function decodeImage(objectUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("decodeFailed"));
    image.src = objectUrl;
  });
}

function reencodeToDataUrl(
  image: HTMLImageElement,
  width: number,
  height: number,
  mime: ModelInlineSafeImageMime,
): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // JPEG has no alpha: fill white so transparent PNG/WebP/GIF sources do not
  // become black (canvas default) in the lossy output. CLI expandMedia uses the
  // same white matte — keep them aligned.
  if (mime === "image/jpeg") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(image, 0, 0, width, height);
  if (mime === "image/jpeg") {
    return canvas.toDataURL("image/jpeg", IMAGE_ENCODE_QUALITY);
  }
  return canvas.toDataURL("image/png");
}

/**
 * Try each target mime in order; return the first data URL under the byte budget.
 * Returns null if every encode failed (canvas), or the last encode's data URL
 * when all were over budget (caller decides oversize vs ok).
 */
function reencodeUntilFits(
  image: HTMLImageElement,
  width: number,
  height: number,
  mimes: readonly ModelInlineSafeImageMime[],
  maxBytes: number,
): { dataUrl: string; byteSize: number; underBudget: boolean } | null {
  let last: { dataUrl: string; byteSize: number } | null = null;
  for (const mime of mimes) {
    const dataUrl = reencodeToDataUrl(image, width, height, mime);
    if (!dataUrl) continue;
    const byteSize = dataUrlByteSize(dataUrl);
    last = { dataUrl, byteSize };
    if (byteSize <= maxBytes) {
      return { dataUrl, byteSize, underBudget: true };
    }
  }
  if (!last) return null;
  return { ...last, underBudget: false };
}

/**
 * Downscale / re-encode a single image file into a base64 data URL suitable for
 * embedding in an OpenAI-shaped `image_url` content part.
 *
 * Policy (default `model-inline-safe`):
 * - Accept PNG/JPEG/WebP/GIF as input.
 * - Passthrough JPEG/PNG when already within edge + byte budgets (no quality loss).
 * - Never emit WebP/GIF on the default profile (local LM Studio / llama.cpp).
 * - Re-encode with an ordered mime chain: PNG may be tried first for sharpness,
 *   but JPEG is always the acceptance fallback so large PNGs still fit.
 */
export async function processImageFile(
  file: File,
  options: ProcessImageOptions = {},
): Promise<ProcessImageResult> {
  if (!isAcceptedImageType(file.type)) {
    return { ok: false, reason: "unsupported", name: file.name };
  }

  const profile = options.profile ?? DEFAULT_IMAGE_INLINE_PROFILE;
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await decodeImage(objectUrl);
    const naturalWidth = image.naturalWidth || image.width;
    const naturalHeight = image.naturalHeight || image.height;
    if (!naturalWidth || !naturalHeight) {
      return { ok: false, reason: "decodeFailed", name: file.name };
    }

    const decision = decideImageEncode({
      sourceMime: file.type,
      width: naturalWidth,
      height: naturalHeight,
      byteSize: file.size,
      maxEdge: MAX_IMAGE_EDGE,
      maxBytes: PER_IMAGE_MAX_BYTES,
      profile,
    });

    if (decision.action === "passthrough") {
      const dataUrl = await readFileAsDataUrl(file);
      const byteSize = dataUrlByteSize(dataUrl);
      // File size and decoded payload size can diverge; re-check before shipping.
      if (byteSize <= PER_IMAGE_MAX_BYTES) {
        return {
          ok: true,
          image: { id: newAttachmentId(), dataUrl, name: file.name, byteSize },
        };
      }
    }

    const { width, height } = scaleWithin(naturalWidth, naturalHeight, MAX_IMAGE_EDGE);
    // Policy chain when reencode was selected; if passthrough only failed the
    // post-read size check, still use a full chain (PNG→JPEG for PNG sources).
    const mimes =
      decision.action === "reencode"
        ? decision.mimes
        : reencodeMimeChain(file.type, file.size <= PER_IMAGE_MAX_BYTES);
    const encoded = reencodeUntilFits(image, width, height, mimes, PER_IMAGE_MAX_BYTES);
    if (!encoded) {
      return { ok: false, reason: "decodeFailed", name: file.name };
    }
    if (!encoded.underBudget) {
      return { ok: false, reason: "oversize", name: file.name };
    }
    return {
      ok: true,
      image: {
        id: newAttachmentId(),
        dataUrl: encoded.dataUrl,
        name: file.name,
        byteSize: encoded.byteSize,
      },
    };
  } catch {
    return { ok: false, reason: "decodeFailed", name: file.name };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
