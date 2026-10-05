import { DEPLOYMENT_COMMAND_MAX_BYTES } from "@ws-model-proxy/config/deployment-protocol";
import { describe, expect, it } from "vitest";
import { deploymentVariantSchema, storedDeploymentVariantSchema } from "./deployment-spec";

const base = {
  key: "spark",
  groupSize: 1,
  resources: [{ kind: "unified", memoryGb: 110 }],
  commands: [{ management: "ownedProcess", start: "serve --port {{port}}", stop: "stop" }],
  readiness: {},
  models: ["glm"],
  attachment: { type: "llm", poolId: "pool" },
  hardConcurrencyLimit: 2,
};
function accepts(overrides: Record<string, unknown>) {
  return deploymentVariantSchema.safeParse({ ...base, ...overrides }).success;
}
function withStart(start: string) {
  return accepts({ commands: [{ management: "ownedProcess", start, stop: "stop" }] });
}

describe("deployment recipe text", () => {
  it("accepts the relay's normalized model ids and refuses ids it would change", () => {
    expect(accepts({ models: ["org/model-7B:Q4"] })).toBe(true);
    // The relay trims reported ids, so a padded id could never match its endpoint.
    for (const model of ["qwen ", " qwen", "   ", "", "a\nb", "a\tb", "a\u0000b"])
      expect(accepts({ models: [model] }), JSON.stringify(model)).toBe(false);
  });

  it("refuses hidden or reordering characters and malformed Unicode in commands", () => {
    expect(withStart("serve --port {{port}}\n  --verbose\t# multi-line")).toBe(true);
    for (const start of [
      "serve ‮;rm -rf ~",
      "serve ⁦x⁩",
      "serve ‏",
      "serve \u0000",
      "serve \u001b[2J",
      "serve \r",
      "serve \u0085",
      "serve \u2028",
      "serve \ufe0f",
      "serve \u{e0041}",
      // Default-ignorable and lookalike-space code points.
      "serve \u180b",
      "serve \u{e0100}",
      "serve \ufff9",
      "serve\u00a0--port",
      "serve\u3000--port",
      "serve \u2800",
      "serve \ud800",
    ])
      expect(withStart(start), JSON.stringify(start)).toBe(false);
  });

  it("refuses an unknown placeholder when the recipe is saved", () => {
    expect(withStart("serve --host {{head_addr}} --gpus {{gpu_ids}}")).toBe(true);
    expect(withStart("serve {{hostname}}")).toBe(false);
  });

  it("limits every saved command to the CLI's UTF-8 byte limit, not its UTF-16 length", () => {
    expect(DEPLOYMENT_COMMAND_MAX_BYTES).toBe(4096);
    expect(withStart("a".repeat(DEPLOYMENT_COMMAND_MAX_BYTES))).toBe(true);
    expect(withStart("a".repeat(DEPLOYMENT_COMMAND_MAX_BYTES + 1))).toBe(false);
    // 2,048 UTF-16 units but 4,097 UTF-8 bytes: the CLI would refuse it.
    const wide = `${"é".repeat(2048)}a`;
    expect(wide.length).toBeLessThan(DEPLOYMENT_COMMAND_MAX_BYTES);
    expect(withStart(wide)).toBe(false);
    expect(withStart("é".repeat(2048))).toBe(true);
    for (const key of ["stop", "prepare", "afterJoin", "status", "health"])
      expect(
        accepts({
          commands: [
            {
              management: "ownedProcess",
              start: "serve",
              stop: "stop",
              [key]: "x".repeat(DEPLOYMENT_COMMAND_MAX_BYTES + 1),
            },
          ],
        }),
        key,
      ).toBe(false);
    // A revision stored before this limit stays readable; rendering refuses it instead.
    expect(
      storedDeploymentVariantSchema.safeParse({
        ...base,
        commands: [{ management: "ownedProcess", start: "a".repeat(32_768), stop: "stop" }],
      }).success,
    ).toBe(true);
  });

  it("applies the text rules to a saved embedding contract", () => {
    const contract = {
      model: "embed",
      revision: "1",
      dimensions: 8,
      normalization: "l2",
      vectorSpace: "space",
    };
    const embedding = (overrides: Record<string, unknown>) =>
      accepts({
        attachment: {
          type: "embeddings",
          poolId: "pool",
          embeddingContract: { ...contract, ...overrides },
        },
      });
    expect(embedding({})).toBe(true);
    expect(embedding({ model: "embed\u0000" })).toBe(false);
    expect(embedding({ revision: "\ud800" })).toBe(false);
    expect(embedding({ vectorSpace: "space\u202e" })).toBe(false);
  });

  it("takes only id-shaped pool ids and a readiness path without controls", () => {
    expect(accepts({ attachment: { type: "llm", poolId: "pool\u0000" } })).toBe(false);
    expect(accepts({ readiness: { path: "/health\u0000" } })).toBe(false);
    expect(accepts({ readiness: { path: "/v1/models" } })).toBe(true);
  });

  it("accepts a speech-to-text recipe and keeps embedding contracts to embedding recipes", () => {
    expect(accepts({ attachment: { type: "transcription", poolId: "pool" } })).toBe(true);
    expect(
      accepts({
        attachment: {
          type: "transcription",
          poolId: "pool",
          embeddingContract: {
            model: "e",
            revision: "1",
            dimensions: 8,
            normalization: "l2",
            vectorSpace: "s",
          },
        },
      }),
    ).toBe(false);
    expect(accepts({ attachment: { type: "speech", poolId: "pool" } })).toBe(false);
  });

  it("takes a bounded transcription profile on transcription recipes only", () => {
    const profile = {
      languages: ["en", "es-MX"],
      responseFormats: ["json", "verbose_json"],
      timestampGranularities: ["word"],
      maxUploadBytes: 26_214_400,
      acceptedMimeTypes: ["audio/wav", "audio/x-m4a"],
    };
    expect(
      accepts({ attachment: { type: "transcription", poolId: "pool", transcription: profile } }),
    ).toBe(true);
    expect(accepts({ attachment: { type: "llm", poolId: "pool", transcription: profile } })).toBe(
      false,
    );
    for (const bad of [
      { languages: ["en us"] },
      { languages: Array.from({ length: 129 }, (_, i) => `l${i}`) },
      { acceptedMimeTypes: ["audio/wav;rate=1"] },
      { maxUploadBytes: 0 },
      { unknown: true },
    ])
      expect(
        accepts({ attachment: { type: "transcription", poolId: "pool", transcription: bad } }),
        JSON.stringify(bad).slice(0, 40),
      ).toBe(false);
  });
});
