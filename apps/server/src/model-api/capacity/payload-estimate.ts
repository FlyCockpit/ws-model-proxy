/** Media-aware request-size estimate. Text uses the existing bytes/2.5
 * conservative ratio; images and audio are counted from headers, not base64. */

export const DEFAULT_IMAGE_TOKEN_ALLOWANCE = 4096;
export const DEFAULT_AUDIO_TOKEN_ALLOWANCE = 4096;
export const IMAGE_PATCH_SIZE = 16;
export const IMAGE_TOKEN_OVERHEAD = 16;
export const AUDIO_TOKENS_PER_SECOND = 50;

export type PayloadEstimate = {
  tokens: number;
  textTokens: number;
  mediaTokens: number;
  mediaParts: number;
};

export type PayloadEstimateOptions = {
  safetyMargin?: number;
  imageTokenAllowance?: number | null;
};

const MAX_DIMENSION_TOKENS = 100_000_000;

export function estimatePayloadTokens(
  payload: unknown,
  options: PayloadEstimateOptions = {},
): PayloadEstimate {
  const safetyMargin = options.safetyMargin ?? 1.2;
  if (!Number.isFinite(safetyMargin) || safetyMargin < 1)
    throw new RangeError("safetyMargin must be at least one.");
  const allowance = resolveAllowance(options.imageTokenAllowance);
  const media: MediaContribution[] = [];
  const stripped = collectAndStrip(payload, media, allowance);
  const serialized = JSON.stringify(stripped);
  if (serialized === undefined) throw new TypeError("Context input must be JSON serializable.");
  const textBytes = new TextEncoder().encode(serialized).byteLength;
  const textTokens = Math.ceil((textBytes / 3) * safetyMargin);
  const mediaTokens = media.reduce((sum, part) => sum + part.tokens, 0);
  const tokens = textTokens + mediaTokens;
  if (!Number.isSafeInteger(tokens) || tokens < 0)
    throw new RangeError("Context token count must be a nonnegative safe integer.");
  return { tokens, textTokens, mediaTokens, mediaParts: media.length };
}

function resolveAllowance(value: number | null | undefined): {
  unknownImage: number;
  cap: number | null;
} {
  if (value === undefined || value === null)
    return { unknownImage: DEFAULT_IMAGE_TOKEN_ALLOWANCE, cap: null };
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError("imageTokenAllowance must be a positive safe integer.");
  return { unknownImage: value, cap: value };
}

type MediaContribution = { tokens: number };

type Allowance = ReturnType<typeof resolveAllowance>;

function collectAndStrip(
  value: unknown,
  media: MediaContribution[],
  allowance: Allowance,
): unknown {
  if (Array.isArray(value)) return value.map((entry) => collectAndStrip(entry, media, allowance));
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const part = recognizeMedia(record);
  if (part) {
    media.push({ tokens: mediaTokens(part, allowance) });
    return stripMediaRecord(record);
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record))
    out[key] = collectAndStrip(entry, media, allowance);
  return out;
}

type RecognizedMedia =
  | { kind: "image"; bytes: Uint8Array | null }
  | { kind: "audio"; bytes: Uint8Array | null }
  | { kind: "unknown" };

function recognizeMedia(record: Record<string, unknown>): RecognizedMedia | null {
  const type = typeof record.type === "string" ? record.type : "";
  if (
    (type === "image_url" || type === "input_image") &&
    (record.image_url != null || record.source != null || record.image != null)
  ) {
    const source = imageSource(record.image_url ?? record.source ?? record.image);
    return { kind: "image", bytes: source ?? null };
  }
  if (
    type === "image" &&
    (record.source != null || record.image_url != null || record.url != null)
  ) {
    const source = imageSource(record.source ?? record.image_url ?? record.url);
    return { kind: "image", bytes: source ?? null };
  }
  if (
    type === "input_audio" &&
    (record.input_audio != null || record.audio != null || record.source != null)
  ) {
    return {
      kind: "audio",
      bytes: audioSource(record.input_audio ?? record.audio ?? record.source),
    };
  }
  if (type === "document" || type === "input_file") {
    const source = fileSource(record);
    if (source?.kind === "image") return { kind: "image", bytes: source.bytes };
    if (source) return { kind: "unknown" };
  }
  return null;
}

function imageSource(value: unknown): Uint8Array | null | undefined {
  if (typeof value === "string") return bytesFromReference(value);
  if (!isRecord(value)) return undefined;
  if (typeof value.url === "string") return bytesFromReference(value.url);
  if (typeof value.data === "string") return decodeBase64(value.data);
  if (value.type === "url" && typeof value.url === "string") return bytesFromReference(value.url);
  if (value.type === "base64" && typeof value.data === "string") return decodeBase64(value.data);
  return undefined;
}

function audioSource(value: unknown): Uint8Array | null {
  if (typeof value === "string") return bytesFromReference(value);
  if (!isRecord(value)) return null;
  if (typeof value.data === "string") return decodeBase64(value.data);
  if (typeof value.url === "string") return bytesFromReference(value.url);
  return null;
}

function fileSource(
  record: Record<string, unknown>,
): { kind: "image"; bytes: Uint8Array | null } | { kind: "unknown" } | null {
  const data =
    typeof record.file_data === "string"
      ? record.file_data
      : typeof record.file_url === "string"
        ? record.file_url
        : null;
  const fromFields = data !== null ? bytesFromReference(data) : undefined;
  const fromSource = imageSource(record.source);
  const bytes = fromFields !== undefined ? fromFields : fromSource;
  if (bytes === undefined && fromSource === undefined && data === null && record.source == null)
    return null;
  const mediaType = mediaTypeOf(record);
  if (mediaType.startsWith("image/")) return { kind: "image", bytes: bytes ?? null };
  if (!mediaType && looksLikeImage(bytes)) return { kind: "image", bytes: bytes ?? null };
  return { kind: "unknown" };
}

function mediaTypeOf(record: Record<string, unknown>): string {
  if (typeof record.media_type === "string") return record.media_type.toLowerCase();
  if (isRecord(record.source) && typeof record.source.media_type === "string")
    return record.source.media_type.toLowerCase();
  if (typeof record.file_data === "string") {
    const match = /^data:([^;,]+)/i.exec(record.file_data);
    if (match?.[1]) return match[1].toLowerCase();
  }
  return "";
}

function looksLikeImage(bytes: Uint8Array | null | undefined): boolean {
  return Boolean(bytes && readImageDimensions(bytes));
}

function bytesFromReference(value: string): Uint8Array | null {
  const trimmed = value.trim();
  const dataUrl = /^data:[^,]*,([\s\S]*)$/i.exec(trimmed);
  if (dataUrl) {
    const isBase64 = /;base64/i.test(trimmed.slice(0, trimmed.indexOf(",")));
    return isBase64 ? decodeBase64(dataUrl[1] ?? "") : null;
  }
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("/")) return null;
  return decodeBase64(trimmed);
}

function stripMediaRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "image_url" || key === "file_data" || key === "file_url" || key === "url") {
      out[key] = typeof value === "string" ? "" : stripReference(value);
      continue;
    }
    if (key === "source" || key === "input_audio" || key === "audio" || key === "image") {
      out[key] = stripReference(value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function stripReference(value: unknown): unknown {
  if (typeof value === "string") return "";
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = { ...value };
  if (typeof out.url === "string") out.url = "";
  if (typeof out.data === "string") out.data = "";
  if (typeof out.file_data === "string") out.file_data = "";
  if (typeof out.file_url === "string") out.file_url = "";
  return out;
}

function mediaTokens(part: RecognizedMedia, allowance: Allowance): number {
  if (part.kind === "image") {
    const dimensions = part.bytes ? readImageDimensions(part.bytes) : null;
    return imageTokens(dimensions, allowance);
  }
  if (part.kind === "audio") {
    const duration = part.bytes ? readWavDurationSeconds(part.bytes) : null;
    if (duration !== null && Number.isFinite(duration) && duration >= 0)
      return Math.max(1, Math.ceil(duration * AUDIO_TOKENS_PER_SECOND));
    return DEFAULT_AUDIO_TOKEN_ALLOWANCE;
  }
  return allowance.unknownImage;
}

function imageTokens(
  dimensions: { width: number; height: number } | null,
  allowance: Allowance,
): number {
  if (!dimensions) return allowance.unknownImage;
  const patches =
    Math.ceil(dimensions.width / IMAGE_PATCH_SIZE) *
    Math.ceil(dimensions.height / IMAGE_PATCH_SIZE);
  if (!Number.isFinite(patches) || patches < 0 || patches > MAX_DIMENSION_TOKENS)
    return allowance.unknownImage;
  const computed = patches + IMAGE_TOKEN_OVERHEAD;
  return allowance.cap === null ? computed : Math.min(computed, allowance.cap);
}

export function readImageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  return (
    pngDimensions(bytes) ?? jpegDimensions(bytes) ?? gifDimensions(bytes) ?? webpDimensions(bytes)
  );
}

export function readWavDurationSeconds(bytes: Uint8Array): number | null {
  if (bytes.length < 44) return null;
  if (!asciiEquals(bytes, 0, "RIFF") || !asciiEquals(bytes, 8, "WAVE")) return null;
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= bytes.length) {
    const id = asciiAt(bytes, offset, 4);
    const size = readUint32LE(bytes, offset + 4);
    const body = offset + 8;
    if (id === "fmt " && size >= 16 && body + 16 <= bytes.length)
      byteRate = readUint32LE(bytes, body + 8);
    if (id === "data") dataSize = size;
    offset = body + size + (size % 2);
  }
  if (byteRate <= 0 || dataSize <= 0) return null;
  return dataSize / byteRate;
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  if (
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a
  )
    return null;
  if (!asciiEquals(bytes, 12, "IHDR")) return null;
  const width = readUint32BE(bytes, 16);
  const height = readUint32BE(bytes, 20);
  return positiveSize(width, height);
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === undefined) return null;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 3 >= bytes.length) return null;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 8 >= bytes.length) return null;
      const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
      return positiveSize(width, height);
    }
    offset += 2 + length;
  }
  return null;
}

function gifDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 10) return null;
  if (!asciiEquals(bytes, 0, "GIF87a") && !asciiEquals(bytes, 0, "GIF89a")) return null;
  return positiveSize(bytes[6]! | (bytes[7]! << 8), bytes[8]! | (bytes[9]! << 8));
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 30) return null;
  if (!asciiEquals(bytes, 0, "RIFF") || !asciiEquals(bytes, 8, "WEBP")) return null;
  const fourcc = asciiAt(bytes, 12, 4);
  if (fourcc === "VP8X") {
    const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
    const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
    return positiveSize(width, height);
  }
  if (fourcc === "VP8 " && bytes.length >= 30) {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    const width = readUint16LE(bytes, 26) & 0x3fff;
    const height = readUint16LE(bytes, 28) & 0x3fff;
    return positiveSize(width, height);
  }
  if (fourcc === "VP8L" && bytes.length >= 25) {
    if (bytes[20] !== 0x2f) return null;
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return positiveSize(width, height);
  }
  return null;
}

function decodeBase64(value: string): Uint8Array | null {
  const cleaned = value.replace(/\s+/g, "");
  if (!cleaned) return null;
  if (/[^A-Za-z0-9+/]/u.test(cleaned.replace(/=+$/u, ""))) return null;
  try {
    const decoded = Buffer.from(cleaned, "base64");
    if (decoded.byteLength === 0) return null;
    return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  } catch {
    return null;
  }
}

function positiveSize(width: number, height: number): { width: number; height: number } | null {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0)
    return null;
  return { width, height };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asciiEquals(bytes: Uint8Array, offset: number, expected: string): boolean {
  return asciiAt(bytes, offset, expected.length) === expected;
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.length) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}
