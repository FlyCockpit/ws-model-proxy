// Browser-only, best-effort compression for oversized Chat Test videos.
//
// This deliberately stays separate from image-attachments.ts: the compressor
// is dynamically imported only after a video is known to exceed its upload cap.

export const VIDEO_COMPRESSION_MAX_DURATION_SECONDS = 6 * 60;

const OUTPUT_SIZE_HEADROOM = 0.88;
const MAX_VIDEO_HEIGHT = 720;
const TARGET_FRAME_RATE = 10;
const AUDIO_BITRATE = 64_000;
const MAX_VIDEO_BITRATE = 750_000;
const MIN_VIDEO_BITRATE = 120_000;

export type VideoCompressionPlan = {
  width: number;
  height: number;
  videoBitrate: number;
};

export type VideoCompressionResult =
  | { status: "compressed"; file: File }
  | { status: "cancelled" }
  | { status: "tooLong" }
  | { status: "cannotFit" }
  | { status: "unsupported" }
  | { status: "failed" };

export type CompressVideoOptions = {
  file: File;
  maxBytes: number;
  signal: AbortSignal;
  onProgress?: (progress: number) => void;
};

/**
 * Calculates a 720p-or-smaller AVC plan that targets the configured upload
 * ceiling. Reserving headroom accounts for the MP4 container and bitrate
 * variation; the completed file is always checked again before upload.
 */
export function createVideoCompressionPlan({
  maxBytes,
  durationSeconds,
  sourceWidth,
  sourceHeight,
}: {
  maxBytes: number;
  durationSeconds: number;
  sourceWidth: number;
  sourceHeight: number;
}): VideoCompressionPlan | null {
  if (
    !Number.isFinite(maxBytes) ||
    !Number.isFinite(durationSeconds) ||
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    maxBytes <= 0 ||
    durationSeconds <= 0 ||
    sourceWidth <= 0 ||
    sourceHeight <= 0
  ) {
    return null;
  }

  const scale = Math.min(1, MAX_VIDEO_HEIGHT / sourceHeight);
  // AVC encoders require even dimensions. Rounding down avoids an accidental
  // upscale while keeping the aspect ratio within a pixel of the source.
  const width = Math.floor((sourceWidth * scale) / 2) * 2;
  const height = Math.floor((sourceHeight * scale) / 2) * 2;
  if (width < 2 || height < 2) return null;
  const totalBitrate = Math.floor((maxBytes * OUTPUT_SIZE_HEADROOM * 8) / durationSeconds);
  const videoBitrate = Math.min(MAX_VIDEO_BITRATE, totalBitrate - AUDIO_BITRATE);

  if (videoBitrate < MIN_VIDEO_BITRATE) return null;
  return { width, height, videoBitrate };
}

function compressedFileName(name: string): string {
  const extensionAt = name.lastIndexOf(".");
  const stem = extensionAt > 0 ? name.slice(0, extensionAt) : name;
  return `${stem || "video"}-compressed.mp4`;
}

/**
 * Transcodes a supported, no-more-than-six-minute video to MP4/AVC/AAC.
 * Codec support comes from the browser's WebCodecs implementation, so every
 * failure is intentionally recoverable by retaining the normal upload limit.
 */
export async function compressVideoToFit({
  file,
  maxBytes,
  signal,
  onProgress,
}: CompressVideoOptions): Promise<VideoCompressionResult> {
  if (signal.aborted) return { status: "cancelled" };

  try {
    const {
      ALL_FORMATS,
      BlobSource,
      BufferTarget,
      canEncodeVideo,
      Conversion,
      Input,
      Mp4OutputFormat,
      Output,
      Quality,
    } = await import("mediabunny");

    if (signal.aborted) return { status: "cancelled" };

    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const durationSeconds = await input.computeDuration();
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return { status: "unsupported" };
    if (durationSeconds > VIDEO_COMPRESSION_MAX_DURATION_SECONDS) return { status: "tooLong" };

    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack || !(await videoTrack.canDecode())) return { status: "unsupported" };

    const plan = createVideoCompressionPlan({
      maxBytes,
      durationSeconds,
      sourceWidth: await videoTrack.getDisplayWidth(),
      sourceHeight: await videoTrack.getDisplayHeight(),
    });
    if (!plan) return { status: "cannotFit" };

    const videoQuality = new Quality({ bitrate: plan.videoBitrate, bitrateMode: "variable" });
    if (!(await canEncodeVideo("avc", { ...plan, quality: videoQuality }))) {
      return { status: "unsupported" };
    }

    const output = new Output({
      target: new BufferTarget(),
      format: new Mp4OutputFormat(),
    });
    const conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      video: {
        ...plan,
        fit: "contain",
        codec: "avc",
        frameRate: TARGET_FRAME_RATE,
        quality: videoQuality,
        forceTranscode: true,
      },
      audio: {
        codec: "aac",
        quality: new Quality({ bitrate: AUDIO_BITRATE, bitrateMode: "variable" }),
        forceTranscode: true,
      },
    });
    if (!conversion.isValid) return { status: "unsupported" };

    const cancel = () => void conversion.cancel();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (signal.aborted) {
        await conversion.cancel();
        return { status: "cancelled" };
      }
      conversion.onProgress = (progress) => onProgress?.(Math.max(0, Math.min(1, progress)));
      await conversion.execute();
    } finally {
      signal.removeEventListener("abort", cancel);
    }

    if (signal.aborted) return { status: "cancelled" };
    const buffer = output.target.buffer;
    if (!buffer) return { status: "failed" };
    const compressed = new File([buffer], compressedFileName(file.name), { type: "video/mp4" });
    return compressed.size <= maxBytes
      ? { status: "compressed", file: compressed }
      : { status: "cannotFit" };
  } catch {
    return signal.aborted ? { status: "cancelled" } : { status: "failed" };
  }
}
