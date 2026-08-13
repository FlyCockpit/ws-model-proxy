import { describe, expect, it, vi } from "vitest";

import {
  createVideoCompressionPlan,
  VIDEO_COMPRESSION_MAX_DURATION_SECONDS,
} from "./video-compression";

const mediabunny = vi.hoisted(() => ({
  conversionInit: vi.fn(),
  output: null as { target: { buffer?: ArrayBuffer } } | null,
}));

vi.mock("mediabunny", () => {
  class BlobSource {}
  class Input {
    async computeDuration() {
      return 60;
    }
    async getPrimaryVideoTrack() {
      return {
        canDecode: async () => true,
        getDisplayWidth: async () => 1920,
        getDisplayHeight: async () => 1080,
      };
    }
  }
  class BufferTarget {
    buffer: ArrayBuffer | undefined;
  }
  class Output {
    target: BufferTarget;
    constructor({ target }: { target: BufferTarget }) {
      this.target = target;
      mediabunny.output = this;
    }
  }
  class Mp4OutputFormat {}
  class Quality {}

  return {
    ALL_FORMATS: [],
    BlobSource,
    BufferTarget,
    canEncodeVideo: async () => true,
    Conversion: { init: mediabunny.conversionInit },
    Input,
    Mp4OutputFormat,
    Output,
    Quality,
  };
});

describe("createVideoCompressionPlan", () => {
  it("targets a six-minute 720p video below the default 25 MiB upload ceiling", () => {
    expect(
      createVideoCompressionPlan({
        maxBytes: 25 * 1024 * 1024,
        durationSeconds: VIDEO_COMPRESSION_MAX_DURATION_SECONDS,
        sourceWidth: 1920,
        sourceHeight: 1080,
      }),
    ).toEqual({ width: 1280, height: 720, videoBitrate: 448_637 });
  });

  it("does not upscale smaller video", () => {
    expect(
      createVideoCompressionPlan({
        maxBytes: 25 * 1024 * 1024,
        durationSeconds: 60,
        sourceWidth: 640,
        sourceHeight: 360,
      }),
    ).toEqual({ width: 640, height: 360, videoBitrate: 750_000 });
  });

  it("rounds portrait output down to AVC-safe even dimensions", () => {
    expect(
      createVideoCompressionPlan({
        maxBytes: 25 * 1024 * 1024,
        durationSeconds: 60,
        sourceWidth: 1080,
        sourceHeight: 1920,
      }),
    ).toEqual({ width: 404, height: 720, videoBitrate: 750_000 });
  });

  it("refuses plans whose available bitrate would be unusably small", () => {
    expect(
      createVideoCompressionPlan({
        maxBytes: 256 * 1024,
        durationSeconds: VIDEO_COMPRESSION_MAX_DURATION_SECONDS,
        sourceWidth: 1280,
        sourceHeight: 720,
      }),
    ).toBeNull();
  });

  it("supplies fit when initializing a conversion with explicit output dimensions", async () => {
    mediabunny.conversionInit.mockImplementation(async () => ({
      isValid: true,
      execute: async () => {
        if (mediabunny.output) mediabunny.output.target.buffer = new ArrayBuffer(128);
      },
      cancel: async () => undefined,
      onProgress: undefined,
    }));
    const { compressVideoToFit } = await import("./video-compression");

    const result = await compressVideoToFit({
      file: new File([new Uint8Array([1])], "clip.mov", { type: "video/quicktime" }),
      maxBytes: 25 * 1024 * 1024,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("compressed");
    expect(mediabunny.conversionInit).toHaveBeenCalledWith(
      expect.objectContaining({ video: expect.objectContaining({ fit: "contain" }) }),
    );
  });
});
