/**
 * Magic-byte sniffing for uploaded media. ALLOWLIST ONLY — every accepted type
 * is a container/codec an image/audio/video model can consume. Anything else
 * (notably SVG, HTML, and other script-carrying "image" formats) is rejected.
 *
 * The client's declared Content-Type is only ever a hint; the STORED and
 * SERVED mime is the one returned here, sniffed from the actual bytes. This is
 * what lets the signed GET route send `X-Content-Type-Options: nosniff` with a
 * trustworthy type.
 *
 * Hand-rolled on purpose (no new dependency): the allowlist is small.
 */

/** Number of header bytes the caller should capture for sniffing. */
export const SNIFF_HEADER_BYTES = 512;

function ascii(buf: Uint8Array, start: number, length: number): string {
  let out = "";
  for (let i = start; i < start + length && i < buf.length; i++) {
    out += String.fromCharCode(buf[i]!);
  }
  return out;
}

function startsWith(buf: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (buf.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[offset + i] !== sig[i]) return false;
  }
  return true;
}

/** ftyp major brand (bytes 8..11) → served mime. Falls back to video/mp4. */
function mp4MimeForBrand(brand: string): string {
  const b = brand.trim();
  // Audio-only MPEG-4 containers.
  if (b === "M4A" || b === "M4A " || b === "M4B" || b === "F4A" || b === "mp42") {
    // mp42 is ambiguous (audio or video); prefer video/mp4 for it below.
  }
  if (b.startsWith("M4A") || b.startsWith("M4B") || b.startsWith("F4A")) return "audio/mp4";
  // QuickTime.
  if (b === "qt") return "video/quicktime";
  // Everything else in the MP4 family (isom, iso2, iso4, iso5, iso6, mp41,
  // mp42, avc1, dash, M4V, mmp4, …) is served as video/mp4.
  return "video/mp4";
}

/**
 * Validate an MPEG audio (MP3) frame header. A bare `FF Ex/Fx` sync is far too
 * loose — roughly 1 in 2048 random byte pairs matches — so also require the
 * frame header's version, layer, and bitrate fields to be non-reserved:
 *   byte1: AAA(sync) BB(version) CC(layer) D(protection)
 *   byte2: EEEE(bitrate index) FF(sample rate) G(padding) H(private)
 * Rejects version bits 01 (reserved), layer bits 00 (reserved), and bitrate
 * index 1111 (invalid), which knocks out the common false positives.
 */
function isMpegAudioFrameSync(buf: Uint8Array): boolean {
  if (buf.length < 3) return false;
  if (buf[0] !== 0xff) return false;
  const b1 = buf[1]!;
  // Top 3 bits of byte 1 complete the 11-bit frame sync.
  if ((b1 & 0xe0) !== 0xe0) return false;
  const version = (b1 >> 3) & 0x03; // 01 = reserved
  if (version === 0x01) return false;
  const layer = (b1 >> 1) & 0x03; // 00 = reserved
  if (layer === 0x00) return false;
  const bitrateIndex = (buf[2]! >> 4) & 0x0f; // 1111 = invalid ("bad")
  if (bitrateIndex === 0x0f) return false;
  return true;
}

/** Search the header for an EBML DocType string to split webm from mkv. */
function ebmlMime(buf: Uint8Array): string {
  const header = ascii(buf, 0, Math.min(buf.length, SNIFF_HEADER_BYTES));
  if (header.includes("webm")) return "video/webm";
  // matroska DocType, or unknown EBML → treat as Matroska.
  return "video/x-matroska";
}

/**
 * Sniff the container/codec from header bytes. Returns the canonical mime to
 * store and serve, or `null` if the bytes are not on the allowlist.
 */
export function sniffMediaMime(buf: Uint8Array): string | null {
  // --- Images ---
  // JPEG: FF D8 FF
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return "image/jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // GIF: "GIF87a" / "GIF89a"
  if (ascii(buf, 0, 6) === "GIF87a" || ascii(buf, 0, 6) === "GIF89a") return "image/gif";
  // WebP: "RIFF"...."WEBP"
  if (ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 4) === "WEBP") return "image/webp";

  // --- Audio ---
  // WAV: "RIFF"...."WAVE"
  if (ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 4) === "WAVE") return "audio/wav";
  // FLAC: "fLaC"
  if (ascii(buf, 0, 4) === "fLaC") return "audio/flac";
  // Ogg / Opus / Vorbis: "OggS"
  if (ascii(buf, 0, 4) === "OggS") return "audio/ogg";
  // MP3: ID3v2 tag, or a validated MPEG audio frame header.
  if (ascii(buf, 0, 3) === "ID3") return "audio/mpeg";
  if (isMpegAudioFrameSync(buf)) return "audio/mpeg";

  // --- ISO-BMFF (mp4 / m4a / mov): bytes 4..7 == "ftyp" ---
  if (ascii(buf, 4, 4) === "ftyp") return mp4MimeForBrand(ascii(buf, 8, 4));

  // --- Matroska / WebM: EBML magic 1A 45 DF A3 ---
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) return ebmlMime(buf);

  return null;
}

export class MediaTypeNotAllowedError extends Error {
  constructor() {
    super(
      "Unsupported or unrecognized media type. Allowed: JPEG, PNG, WebP, GIF, MP3, WAV, Ogg/Opus, FLAC, MP4/M4A/MOV, WebM/MKV.",
    );
    this.name = "MediaTypeNotAllowedError";
  }
}
