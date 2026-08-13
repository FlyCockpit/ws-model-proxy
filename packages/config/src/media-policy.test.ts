import { describe, expect, it } from "vitest";

import {
  acceptedMediaInputAcceptAttr,
  CLIENT_ACCEPTED_MEDIA_MIMES,
  clampMediaAttachmentMaxBytes,
  decideImageEncode,
  imageNeedsInlineNormalization,
  isClientAcceptedImageMime,
  isClientAcceptedMediaMime,
  isModelInlineSafeImageMime,
  MEDIA_EXTENSION_MIME_MAP,
  MEDIA_MIME_ALIASES,
  mediaInputInfo,
  normalizeImageMime,
  reencodeMimeChain,
} from "./media-policy";

describe("attachment size policy", () => {
  it("clamps persisted global limits to the safe database range", () => {
    expect(clampMediaAttachmentMaxBytes(1)).toBe(256 * 1024);
    expect(clampMediaAttachmentMaxBytes(8 * 1024 * 1024)).toBe(8 * 1024 * 1024);
    expect(clampMediaAttachmentMaxBytes(2 ** 32)).toBe(2 ** 31 - 1);
  });
});

describe("normalizeImageMime", () => {
  it("strips parameters, lowercases, and aliases image/jpg", () => {
    expect(normalizeImageMime("image/JPEG; charset=binary")).toBe("image/jpeg");
    expect(normalizeImageMime("image/jpg")).toBe("image/jpeg");
  });
});

describe("mime allowlists", () => {
  it("treats jpeg/png as model-inline-safe (including image/jpg alias)", () => {
    expect(isModelInlineSafeImageMime("image/jpeg")).toBe(true);
    expect(isModelInlineSafeImageMime("image/jpg")).toBe(true);
    expect(isModelInlineSafeImageMime("image/png")).toBe(true);
    expect(isModelInlineSafeImageMime("image/webp")).toBe(false);
    expect(isModelInlineSafeImageMime("image/gif")).toBe(false);
  });

  it("accepts webp/gif as client inputs", () => {
    expect(isClientAcceptedImageMime("image/webp")).toBe(true);
    expect(isClientAcceptedImageMime("image/gif")).toBe(true);
    expect(isClientAcceptedImageMime("image/svg+xml")).toBe(false);
  });
});

describe("browser media-input catalog", () => {
  it("keeps alias and extension targets in the canonical allowlist", () => {
    for (const mime of [
      ...Object.values(MEDIA_MIME_ALIASES),
      ...Object.values(MEDIA_EXTENSION_MIME_MAP),
    ]) {
      expect(CLIENT_ACCEPTED_MEDIA_MIMES).toContain(mime);
      expect(isClientAcceptedMediaMime(mime)).toBe(true);
    }
  });

  it("falls back to a supported extension when WebKit returns an empty or generic type", () => {
    expect(mediaInputInfo({ name: "voice-note.m4a", type: "" })).toEqual({
      modality: "audio",
      mime: "audio/mp4",
    });
    expect(mediaInputInfo({ name: "voice-note.m4a", type: "application/octet-stream" })).toEqual({
      modality: "audio",
      mime: "audio/mp4",
    });
  });

  it("uses the M4A/M4B extension for ambiguous generic MP4 declarations", () => {
    expect(mediaInputInfo({ name: "voice-note.m4a", type: "video/mp4" })).toEqual({
      modality: "audio",
      mime: "audio/mp4",
    });
  });

  it("otherwise gives a known declared MIME precedence over the filename", () => {
    expect(mediaInputInfo({ name: "clip.mp4", type: "audio/mpeg" })).toEqual({
      modality: "audio",
      mime: "audio/mpeg",
    });
  });

  it("derives a modality-specific accept filter from the same catalog", () => {
    const accept = acceptedMediaInputAcceptAttr({ image: false, audio: true, video: true });

    expect(accept).toContain("audio/x-m4a");
    expect(accept).toContain(".m4a");
    expect(accept).toContain(".mov");
    expect(accept).not.toContain(".jpg");
  });
});

describe("reencodeMimeChain", () => {
  it("prefers png then jpeg when a png source is still under the byte budget", () => {
    expect(reencodeMimeChain("image/png", true)).toEqual(["image/png", "image/jpeg"]);
  });

  it("skips png and goes straight to jpeg when the png source is already over budget", () => {
    expect(reencodeMimeChain("image/png", false)).toEqual(["image/jpeg"]);
  });

  it("uses jpeg only for non-png sources", () => {
    expect(reencodeMimeChain("image/webp", true)).toEqual(["image/jpeg"]);
    expect(reencodeMimeChain("image/jpeg", false)).toEqual(["image/jpeg"]);
  });
});

describe("decideImageEncode", () => {
  it("passthroughs small jpeg/png under edge limits (model-inline-safe)", () => {
    expect(
      decideImageEncode({
        sourceMime: "image/jpeg",
        width: 800,
        height: 600,
        byteSize: 120_000,
        maxEdge: 2048,
        maxBytes: 2 * 1024 * 1024,
      }),
    ).toEqual({ action: "passthrough" });

    expect(
      decideImageEncode({
        sourceMime: "image/png",
        width: 100,
        height: 100,
        byteSize: 50_000,
        maxEdge: 2048,
        maxBytes: 2 * 1024 * 1024,
      }),
    ).toEqual({ action: "passthrough" });
  });

  it("never passthroughs webp/gif on the default local-safe profile", () => {
    expect(
      decideImageEncode({
        sourceMime: "image/webp",
        width: 100,
        height: 100,
        byteSize: 10_000,
      }),
    ).toEqual({ action: "reencode", mimes: ["image/jpeg"] });

    expect(
      decideImageEncode({
        sourceMime: "image/gif",
        width: 100,
        height: 100,
        byteSize: 10_000,
      }),
    ).toEqual({ action: "reencode", mimes: ["image/jpeg"] });
  });

  it("allows webp passthrough only on openai-broad when under limits", () => {
    expect(
      decideImageEncode({
        sourceMime: "image/webp",
        width: 100,
        height: 100,
        byteSize: 10_000,
        profile: "openai-broad",
      }),
    ).toEqual({ action: "passthrough" });

    expect(
      decideImageEncode({
        sourceMime: "image/webp",
        width: 4000,
        height: 3000,
        byteSize: 10_000,
        profile: "openai-broad",
        maxEdge: 2048,
      }),
    ).toEqual({ action: "reencode", mimes: ["image/jpeg"] });
  });

  it("for over-edge png under byte budget: try png then jpeg", () => {
    expect(
      decideImageEncode({
        sourceMime: "image/png",
        width: 4000,
        height: 3000,
        byteSize: 100_000,
        maxEdge: 2048,
        maxBytes: 2 * 1024 * 1024,
      }),
    ).toEqual({ action: "reencode", mimes: ["image/png", "image/jpeg"] });
  });

  it("for over-budget png: jpeg only so fit wins over sharpness", () => {
    expect(
      decideImageEncode({
        sourceMime: "image/png",
        width: 800,
        height: 600,
        byteSize: 3 * 1024 * 1024,
        maxBytes: 2 * 1024 * 1024,
      }),
    ).toEqual({ action: "reencode", mimes: ["image/jpeg"] });
  });

  it("for over-edge jpeg: jpeg only", () => {
    expect(
      decideImageEncode({
        sourceMime: "image/jpeg",
        width: 4000,
        height: 3000,
        byteSize: 100_000,
        maxEdge: 2048,
      }),
    ).toEqual({ action: "reencode", mimes: ["image/jpeg"] });
  });
});

describe("imageNeedsInlineNormalization", () => {
  it("flags only non-safe still-image mimes", () => {
    expect(imageNeedsInlineNormalization("image/webp")).toBe(true);
    expect(imageNeedsInlineNormalization("image/gif")).toBe(true);
    expect(imageNeedsInlineNormalization("image/jpeg")).toBe(false);
    expect(imageNeedsInlineNormalization("image/jpg")).toBe(false);
    expect(imageNeedsInlineNormalization("image/png")).toBe(false);
    expect(imageNeedsInlineNormalization("video/mp4")).toBe(false);
    expect(imageNeedsInlineNormalization("audio/wav")).toBe(false);
  });
});
