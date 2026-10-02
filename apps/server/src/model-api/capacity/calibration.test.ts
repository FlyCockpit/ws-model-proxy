import { afterEach, describe, expect, it } from "vitest";
import {
  CALIBRATION_CLAMP_MAX,
  CALIBRATION_CLAMP_MIN,
  CALIBRATION_MIN_SAMPLES,
  CALIBRATION_RATIO_MAX,
  CALIBRATION_RATIO_MIN,
  calibratedContextTokens,
  calibratedFootprintTokens,
  observeContextCalibration,
  resetContextCalibrationForTests,
} from "./calibration.js";

const identity = {
  runtimeIdentityKey: "rt",
  runtimeModel: "model",
  runtimeRevision: "1",
};

afterEach(() => resetContextCalibrationForTests());

function fill(capacityId: string, ratios: number[], id = identity) {
  for (const ratio of ratios)
    observeContextCalibration({
      capacityId,
      identity: id,
      textEstimate: 1000,
      promptTokens: 1000 * ratio,
      mediaParts: 0,
    });
}

describe("context calibration", () => {
  it("stays unused until the warm-up threshold", () => {
    fill(
      "cap",
      Array.from({ length: CALIBRATION_MIN_SAMPLES - 1 }, () => 0.8),
    );
    expect(calibratedContextTokens("cap", identity, 1000)).toBeNull();
    expect(calibratedFootprintTokens("cap", identity, 1000)).toBeNull();
  });

  it("uses p95 for context checks and the median for footprints", () => {
    fill(
      "cap",
      Array.from({ length: CALIBRATION_MIN_SAMPLES }, (_, index) => 0.5 + index * 0.01),
    );
    const p95 = calibratedContextTokens("cap", identity, 1000);
    const median = calibratedFootprintTokens("cap", identity, 1000);
    expect(p95).toBeGreaterThan(median!);
    expect(p95).toBeGreaterThanOrEqual(Math.ceil(1000 * 0.68));
    expect(median).toBeGreaterThanOrEqual(Math.ceil(1000 * 0.59));
    expect(median).toBeLessThanOrEqual(Math.ceil(1000 * 0.61));
  });

  it("clamps to [0.3, 1.5] of the text estimate", () => {
    fill(
      "cap",
      Array.from({ length: CALIBRATION_MIN_SAMPLES }, () => 0.2),
    );
    expect(calibratedContextTokens("cap", identity, 1000)).toBe(
      Math.ceil(1000 * CALIBRATION_CLAMP_MIN),
    );
    resetContextCalibrationForTests();
    fill(
      "cap",
      Array.from({ length: CALIBRATION_MIN_SAMPLES }, () => 1.8),
    );
    expect(calibratedContextTokens("cap", identity, 1000)).toBe(
      Math.ceil(1000 * CALIBRATION_CLAMP_MAX),
    );
  });

  it("drops implausible ratios instead of storing them", () => {
    fill(
      "cap",
      Array.from({ length: CALIBRATION_MIN_SAMPLES - 1 }, () => 0.8),
    );
    observeContextCalibration({
      capacityId: "cap",
      identity,
      textEstimate: 1000,
      promptTokens: 1000 * (CALIBRATION_RATIO_MIN / 2),
      mediaParts: 0,
    });
    observeContextCalibration({
      capacityId: "cap",
      identity,
      textEstimate: 1000,
      promptTokens: 1000 * (CALIBRATION_RATIO_MAX + 1),
      mediaParts: 0,
    });
    expect(calibratedContextTokens("cap", identity, 1000)).toBeNull();
    fill("cap", [0.8]);
    expect(calibratedContextTokens("cap", identity, 1000)).toBe(Math.ceil(1000 * 0.8));
  });

  it("does not let oversized metadata clamp other tenants to 0.3", () => {
    fill(
      "cap",
      Array.from({ length: CALIBRATION_MIN_SAMPLES }, () => 0.8),
    );
    observeContextCalibration({
      capacityId: "cap",
      identity,
      textEstimate: 100_000,
      promptTokens: 800,
      mediaParts: 0,
    });
    expect(calibratedContextTokens("cap", identity, 1000)).toBe(Math.ceil(1000 * 0.8));
  });

  it("applies the factor to text tokens only", () => {
    fill(
      "cap",
      Array.from({ length: CALIBRATION_MIN_SAMPLES }, () => 0.8),
    );
    expect(calibratedContextTokens("cap", identity, 1000, 4096)).toBe(Math.ceil(1000 * 0.8) + 4096);
    expect(calibratedFootprintTokens("cap", identity, 1000, 4096)).toBe(
      Math.ceil(1000 * 0.8) + 4096,
    );
  });

  it("resets when runtime identity changes", () => {
    fill(
      "cap",
      Array.from({ length: CALIBRATION_MIN_SAMPLES }, () => 0.8),
    );
    expect(calibratedContextTokens("cap", identity, 1000)).not.toBeNull();
    observeContextCalibration({
      capacityId: "cap",
      identity: { ...identity, runtimeRevision: "2" },
      textEstimate: 1000,
      promptTokens: 800,
      mediaParts: 0,
    });
    expect(calibratedContextTokens("cap", { ...identity, runtimeRevision: "2" }, 1000)).toBeNull();
  });

  it("ignores media requests", () => {
    fill(
      "cap",
      Array.from({ length: CALIBRATION_MIN_SAMPLES }, () => 0.8),
    );
    observeContextCalibration({
      capacityId: "cap",
      identity,
      textEstimate: 1000,
      promptTokens: 100,
      mediaParts: 1,
    });
    expect(calibratedContextTokens("cap", identity, 1000)).toBe(Math.ceil(1000 * 0.8));
  });
});
