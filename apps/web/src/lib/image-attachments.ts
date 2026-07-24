// Client-side image attachment helpers for the chat-test composer.
//
// Phase 0 of the multimodal asset plan: images are attached by downscaling and
// re-encoding them in the browser, then embedding them as base64 `data:` URLs
// inside OpenAI-shaped content parts. No server storage is involved.
//
// Size budget rationale (see asset-plan.md "Size limits"):
//   - The internal chat-test route enforces a global 10 MB Hono body limit.
//   - The CLI relay now STREAMS request bodies, so the old ~8 MiB buffered-chunk
//     cap no longer applies — the 10 MB internal route body limit is the real
//     remaining ceiling for base64-through-relay.
//   - Multi-turn history RE-SENDS every prior image as base64 each turn.
// So we keep a conservative per-image cap and a total-request budget that both
// sit safely below that 10 MB route limit.

export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export const ACCEPTED_IMAGE_ACCEPT_ATTR = ACCEPTED_IMAGE_TYPES.join(",");

// Longest edge after downscaling; matches the asset plan's client guidance.
export const MAX_IMAGE_EDGE = 2048;

// Re-encode quality for lossy WebP/JPEG output.
export const IMAGE_ENCODE_QUALITY = 0.85;

// Max number of images that may be attached to a single composer message.
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;

// GIFs smaller than this are passed through untouched to preserve animation.
// Larger GIFs are rasterized to their first frame during downscale/re-encode.
export const GIF_PASSTHROUGH_MAX_BYTES = 512 * 1024;

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

export function isAcceptedImageType(type: string): boolean {
  return (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(type);
}

let webpSupport: boolean | null = null;
function supportsWebp(): boolean {
  if (webpSupport !== null) return webpSupport;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    webpSupport = canvas.toDataURL("image/webp").startsWith("data:image/webp");
  } catch {
    webpSupport = false;
  }
  return webpSupport;
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

/**
 * Downscale + re-encode a single image file into a base64 data URL suitable for
 * embedding in an OpenAI-shaped `image_url` content part.
 */
export async function processImageFile(file: File): Promise<ProcessImageResult> {
  if (!isAcceptedImageType(file.type)) {
    return { ok: false, reason: "unsupported", name: file.name };
  }

  // Small GIFs pass through untouched so animation survives.
  if (file.type === "image/gif" && file.size <= GIF_PASSTHROUGH_MAX_BYTES) {
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const byteSize = dataUrlByteSize(dataUrl);
      if (byteSize > PER_IMAGE_MAX_BYTES) {
        return { ok: false, reason: "oversize", name: file.name };
      }
      return {
        ok: true,
        image: { id: newAttachmentId(), dataUrl, name: file.name, byteSize },
      };
    } catch {
      return { ok: false, reason: "decodeFailed", name: file.name };
    }
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await decodeImage(objectUrl);
    const naturalWidth = image.naturalWidth || image.width;
    const naturalHeight = image.naturalHeight || image.height;
    if (!naturalWidth || !naturalHeight) {
      return { ok: false, reason: "decodeFailed", name: file.name };
    }

    const { width, height } = scaleWithin(naturalWidth, naturalHeight, MAX_IMAGE_EDGE);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return { ok: false, reason: "decodeFailed", name: file.name };
    }
    ctx.drawImage(image, 0, 0, width, height);

    // WebP where supported (smaller), else JPEG. Both re-encode at ~0.85.
    const mime = supportsWebp() ? "image/webp" : "image/jpeg";
    const dataUrl = canvas.toDataURL(mime, IMAGE_ENCODE_QUALITY);
    const byteSize = dataUrlByteSize(dataUrl);
    if (byteSize > PER_IMAGE_MAX_BYTES) {
      return { ok: false, reason: "oversize", name: file.name };
    }
    return {
      ok: true,
      image: { id: newAttachmentId(), dataUrl, name: file.name, byteSize },
    };
  } catch {
    return { ok: false, reason: "decodeFailed", name: file.name };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
