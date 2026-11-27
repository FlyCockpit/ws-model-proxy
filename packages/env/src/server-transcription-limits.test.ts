import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_VARS } from "../../../scripts/lib/env-manifest.js";
import {
  TRANSCRIPTION_MAX_MULTIPART_BYTES_DEFAULT,
  TRANSCRIPTION_MAX_UPLOAD_BYTES_DEFAULT,
} from "./transcription-limits.js";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DATABASE_URL", "postgresql://env-test@127.0.0.1:5432/env_test");
  vi.stubEnv("BETTER_AUTH_SECRET", "test-transcription-limits-secret-32-characters");
  vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
  vi.stubEnv("MODEL_API_TRANSCRIPTION_MAX_UPLOAD_BYTES", undefined);
  vi.stubEnv("MODEL_API_TRANSCRIPTION_MAX_MULTIPART_BYTES", undefined);
});

afterEach(() => vi.unstubAllEnvs());

describe("transcription deployment limits", () => {
  it("keeps schema and generated examples below a 100,000,000-byte proxy body cap", async () => {
    const { env } = await import("./server.js");
    expect(env.MODEL_API_TRANSCRIPTION_MAX_UPLOAD_BYTES).toBe(
      TRANSCRIPTION_MAX_UPLOAD_BYTES_DEFAULT,
    );
    expect(env.MODEL_API_TRANSCRIPTION_MAX_MULTIPART_BYTES).toBe(
      TRANSCRIPTION_MAX_MULTIPART_BYTES_DEFAULT,
    );
    expect(env.MODEL_API_TRANSCRIPTION_MAX_MULTIPART_BYTES).toBe(
      env.MODEL_API_TRANSCRIPTION_MAX_UPLOAD_BYTES + 1024 * 1024,
    );
    expect(env.MODEL_API_TRANSCRIPTION_MAX_MULTIPART_BYTES).toBeLessThan(100_000_000);
    for (const key of [
      "MODEL_API_TRANSCRIPTION_MAX_UPLOAD_BYTES",
      "MODEL_API_TRANSCRIPTION_MAX_MULTIPART_BYTES",
    ] as const) {
      expect(ENV_VARS.find((entry) => entry.key === key)?.default).toBe(String(env[key]));
    }
  });

  it("preserves independent overrides for deployments with different proxy limits", async () => {
    vi.stubEnv("MODEL_API_TRANSCRIPTION_MAX_UPLOAD_BYTES", "104857600");
    vi.stubEnv("MODEL_API_TRANSCRIPTION_MAX_MULTIPART_BYTES", "106954752");
    const { env } = await import("./server.js");
    expect(env.MODEL_API_TRANSCRIPTION_MAX_UPLOAD_BYTES).toBe(104857600);
    expect(env.MODEL_API_TRANSCRIPTION_MAX_MULTIPART_BYTES).toBe(106954752);
  });
});
