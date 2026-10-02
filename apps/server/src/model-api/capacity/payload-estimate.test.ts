import { describe, expect, it } from "vitest";
import {
  AUDIO_TOKENS_PER_SECOND,
  DEFAULT_AUDIO_TOKEN_ALLOWANCE,
  DEFAULT_DOCUMENT_TOKEN_ALLOWANCE,
  DEFAULT_IMAGE_TOKEN_ALLOWANCE,
  DOCUMENT_BYTES_PER_TOKEN,
  estimatePayloadTokens,
  IMAGE_PATCH_SIZE,
  IMAGE_TOKEN_OVERHEAD,
  readImageDimensions,
  readWavDurationSeconds,
} from "./payload-estimate.js";

function pngBytes(width: number, height: number, extra = 0): Uint8Array {
  const bytes = new Uint8Array(24 + extra);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes[11] = 13;
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function jpegBytes(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
  ]);
}

function gifBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(10);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  bytes[6] = width & 0xff;
  bytes[7] = (width >> 8) & 0xff;
  bytes[8] = height & 0xff;
  bytes[9] = (height >> 8) & 0xff;
  return bytes;
}

function webpVp8xBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  const view = new DataView(bytes.buffer);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, 22, true);
  bytes.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58], 8);
  view.setUint32(16, 10, true);
  const w = width - 1;
  const h = height - 1;
  bytes[24] = w & 0xff;
  bytes[25] = (w >> 8) & 0xff;
  bytes[26] = (w >> 16) & 0xff;
  bytes[27] = h & 0xff;
  bytes[28] = (h >> 8) & 0xff;
  bytes[29] = (h >> 16) & 0xff;
  return bytes;
}

function wavBytes(durationSeconds: number): Uint8Array {
  const byteRate = 32_000;
  const dataSize = byteRate * durationSeconds;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, 36 + dataSize, true);
  bytes.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set([0x64, 0x61, 0x74, 0x61], 36);
  view.setUint32(40, dataSize, true);
  return bytes;
}

function dataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

function imageTokensFor(width: number, height: number): number {
  return (
    Math.ceil(width / IMAGE_PATCH_SIZE) * Math.ceil(height / IMAGE_PATCH_SIZE) +
    IMAGE_TOKEN_OVERHEAD
  );
}

describe("image header parsers", () => {
  it("reads PNG, JPEG, WebP, and GIF dimensions", () => {
    expect(readImageDimensions(pngBytes(64, 48))).toEqual({ width: 64, height: 48 });
    expect(readImageDimensions(jpegBytes(128, 96))).toEqual({ width: 128, height: 96 });
    expect(readImageDimensions(webpVp8xBytes(320, 240))).toEqual({ width: 320, height: 240 });
    expect(readImageDimensions(gifBytes(16, 32))).toEqual({ width: 16, height: 32 });
  });

  it("rejects truncated or invalid headers", () => {
    expect(readImageDimensions(pngBytes(10, 10).subarray(0, 12))).toBeNull();
    expect(readImageDimensions(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
    expect(readImageDimensions(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});

describe("payload media estimates", () => {
  it("counts a PNG image_url from its header instead of base64 bytes", () => {
    const url = dataUrl("image/png", pngBytes(64, 64));
    const estimate = estimatePayloadTokens({
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url } }],
        },
      ],
    });
    expect(estimate.mediaParts).toBe(1);
    expect(estimate.mediaTokens).toBe(imageTokensFor(64, 64));
    expect(estimate.tokens).toBe(estimate.textTokens + estimate.mediaTokens);
  });

  it("uses the default allowance for URL images and invalid or truncated base64", () => {
    const urlEstimate = estimatePayloadTokens({
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://cdn.example/a.png" } }],
        },
      ],
    });
    expect(urlEstimate.mediaTokens).toBe(DEFAULT_IMAGE_TOKEN_ALLOWANCE);
    const invalid = estimatePayloadTokens({
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,$$$$" } },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,abc" } },
          ],
        },
      ],
    });
    expect(invalid.mediaParts).toBe(2);
    expect(invalid.mediaTokens).toBe(DEFAULT_IMAGE_TOKEN_ALLOWANCE * 2);
  });

  it("reads Anthropic image and document sources", () => {
    const png = Buffer.from(pngBytes(32, 16)).toString("base64");
    const estimate = estimatePayloadTokens({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: png },
            },
            {
              type: "image",
              source: { type: "url", url: "https://cdn.example/photo.jpg" },
            },
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: png },
            },
          ],
        },
      ],
    });
    expect(estimate.mediaParts).toBe(3);
    const pdfTokens = Math.ceil(pngBytes(32, 16).byteLength / DOCUMENT_BYTES_PER_TOKEN);
    expect(pdfTokens).not.toBe(DEFAULT_IMAGE_TOKEN_ALLOWANCE);
    expect(estimate.mediaTokens).toBe(
      imageTokensFor(32, 16) + DEFAULT_IMAGE_TOKEN_ALLOWANCE + pdfTokens,
    );
  });

  it("counts Anthropic text documents as text, not the image allowance", () => {
    const text = "a".repeat(900_000);
    const estimate = estimatePayloadTokens({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "text", media_type: "text/plain", data: text },
            },
          ],
        },
      ],
    });
    expect(estimate.mediaParts).toBe(0);
    expect(estimate.tokens).toBeGreaterThan(4096);
    expect(estimate.textTokens).toBeGreaterThan(4096);
  });

  it("sizes PDFs from bytes and keeps the image flat allowance for unread dimensions", () => {
    const pdf = new Uint8Array(50_000).fill(37);
    const estimate = estimatePayloadTokens({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: Buffer.from(pdf).toString("base64"),
              },
            },
            {
              type: "image_url",
              image_url: { url: "https://cdn.example/photo.jpg" },
            },
          ],
        },
      ],
    });
    expect(estimate.mediaParts).toBe(2);
    expect(estimate.mediaTokens).toBe(
      Math.ceil(pdf.byteLength / DOCUMENT_BYTES_PER_TOKEN) + DEFAULT_IMAGE_TOKEN_ALLOWANCE,
    );
    expect(estimate.mediaTokens).not.toBe(DEFAULT_IMAGE_TOKEN_ALLOWANCE * 2);
    const urlOnly = estimatePayloadTokens({
      input: [{ type: "input_file", file_url: "https://files.example/doc.pdf" }],
    });
    expect(urlOnly.mediaTokens).toBe(DEFAULT_DOCUMENT_TOKEN_ALLOWANCE);
    expect(urlOnly.mediaTokens).not.toBe(DEFAULT_IMAGE_TOKEN_ALLOWANCE);
  });

  it("reads Responses input_image and input_file shapes", () => {
    const png = dataUrl("image/png", pngBytes(48, 48));
    const estimate = estimatePayloadTokens({
      input: [
        {
          role: "user",
          content: [
            { type: "input_image", image_url: png },
            { type: "input_file", file_url: "https://files.example/doc.pdf" },
            { type: "input_file", file_data: png },
          ],
        },
      ],
    });
    expect(estimate.mediaParts).toBe(3);
    expect(estimate.mediaTokens).toBe(
      imageTokensFor(48, 48) * 2 + DEFAULT_DOCUMENT_TOKEN_ALLOWANCE,
    );
  });

  it("counts WAV duration and falls back for unknown audio", () => {
    const wav = Buffer.from(wavBytes(2)).toString("base64");
    const wavEstimate = estimatePayloadTokens({
      messages: [
        {
          role: "user",
          content: [{ type: "input_audio", input_audio: { data: wav, format: "wav" } }],
        },
      ],
    });
    expect(readWavDurationSeconds(wavBytes(2))).toBe(2);
    expect(wavEstimate.mediaTokens).toBe(2 * AUDIO_TOKENS_PER_SECOND);
    const unknown = estimatePayloadTokens({
      messages: [
        {
          role: "user",
          content: [{ type: "input_audio", input_audio: { data: "AAAA", format: "mp3" } }],
        },
      ],
    });
    expect(unknown.mediaTokens).toBe(DEFAULT_AUDIO_TOKEN_ALLOWANCE);
  });

  it("caps known images when a per-capacity allowance is set", () => {
    const url = dataUrl("image/png", pngBytes(1024, 1024));
    const uncapped = estimatePayloadTokens({
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }],
    });
    const capped = estimatePayloadTokens(
      { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }] },
      { imageTokenAllowance: 100 },
    );
    expect(uncapped.mediaTokens).toBe(imageTokensFor(1024, 1024));
    expect(capped.mediaTokens).toBe(100);
  });

  it("does not count JSON schema type names as media", () => {
    const estimate = estimatePayloadTokens({
      tools: [{ type: "function", function: { parameters: { type: "image_url" } } }],
    });
    expect(estimate.mediaParts).toBe(0);
  });
});
