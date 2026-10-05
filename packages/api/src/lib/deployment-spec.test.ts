import { DEPLOYMENT_COMMAND_MAX_BYTES } from "@ws-model-proxy/config/deployment-protocol";
import { describe, expect, it } from "vitest";
import {
  DEPLOYMENT_CONFIG_SLUG_PATTERN,
  deploymentVariantSchema,
  storedDeploymentVariantSchema,
  unusedInteractiveFlags,
} from "./deployment-spec";

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
    // The CLI counts UTF-8 bytes: 128 two-byte characters fit, one more byte does not.
    for (const key of ["model", "revision", "vectorSpace"]) {
      expect(embedding({ [key]: "é".repeat(128) }), key).toBe(true);
      expect(embedding({ [key]: `${"é".repeat(128)}a` }), key).toBe(false);
    }
  });

  it("matches the CLI's model id and readiness path limits in UTF-8 bytes", () => {
    expect(accepts({ models: ["é".repeat(128)] })).toBe(true);
    expect(accepts({ models: [`${"é".repeat(128)}a`] })).toBe(false);
    expect(accepts({ readiness: { path: `/${"é".repeat(1023)}a` } })).toBe(true);
    expect(accepts({ readiness: { path: `/${"é".repeat(1024)}` } })).toBe(false);
    expect(accepts({ readiness: { path: "/health?ready=1" } })).toBe(true);
    expect(accepts({ readiness: { path: "/" } })).toBe(true);
    for (const path of ["/health#ready", "//health", "//", "health"])
      expect(accepts({ readiness: { path } }), path).toBe(false);
    // The stored schema keeps reading older revisions; starting them is refused.
    for (const readiness of [{ path: "/health#ready" }, { path: "//health" }])
      expect(storedDeploymentVariantSchema.safeParse({ ...base, readiness }).success).toBe(true);
  });

  it("allows recipe slugs that render a valid instance endpoint slug only", () => {
    for (const slug of ["q", "qwen", "qwen-3", "a1-b2-c3", "a".repeat(41)])
      expect(DEPLOYMENT_CONFIG_SLUG_PATTERN.test(slug), slug).toBe(true);
    for (const slug of ["qwen-", "qw--en", "-qwen", "1qwen", "Qwen", "a".repeat(42), ""])
      expect(DEPLOYMENT_CONFIG_SLUG_PATTERN.test(slug), slug).toBe(false);
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

  it("takes an opt-in realtime block with the adapter's bounds", () => {
    const stt = (realtime: unknown, engine = "vllm") =>
      accepts({
        engine,
        attachment: { type: "transcription", poolId: "pool", transcription: { realtime } },
      });
    expect(stt({ adapter: "vllm" })).toBe(true);
    expect(stt({ adapter: "vllm", maxItemSeconds: 600, maxSessions: 8 })).toBe(true);
    expect(stt({ adapter: "segmented", maxItemSeconds: 120, maxSessions: 1 }, "llama.cpp")).toBe(
      true,
    );
    // vLLM's realtime route needs a vLLM server; `other` covers wrapper commands.
    expect(stt({ adapter: "vllm" }, "other")).toBe(true);
    expect(stt({ adapter: "vllm" }, "sglang")).toBe(false);
    expect(stt({ adapter: "vllm" }, "llama.cpp")).toBe(false);
    for (const bad of [
      {},
      { adapter: "openai" },
      { adapter: "segmented", maxItemSeconds: 121 },
      { adapter: "vllm", maxItemSeconds: 4 },
      { adapter: "vllm", maxItemSeconds: 601 },
      { adapter: "vllm", maxItemSeconds: 30.5 },
      { adapter: "vllm", maxSessions: 0 },
      { adapter: "vllm", maxSessions: 9 },
      { adapter: "vllm", supported: true },
    ])
      expect(stt(bad), JSON.stringify(bad)).toBe(false);
  });
});

describe("interactive recipe commands", () => {
  const external = {
    management: "externalService",
    start: "systemctl start llm",
    stop: "systemctl stop llm",
    prepare: "prepare",
    afterJoin: "after-join",
    status: "systemctl is-active llm",
  };
  const owned = { management: "ownedProcess", start: "serve", stop: "stop", prepare: "prep" };
  const withCommands = (commands: Record<string, unknown>) =>
    deploymentVariantSchema.safeParse({ ...base, commands: [commands] });

  it("accepts every interactive phase on an external service with status", () => {
    for (const interactive of [
      { start: true },
      { stop: true },
      { prepare: true },
      { afterJoin: true },
      { start: true, stop: true, prepare: true, afterJoin: true },
      {},
    ]) {
      const parsed = withCommands({ ...external, interactive });
      expect(parsed.success, JSON.stringify(interactive)).toBe(true);
      expect(parsed.data?.commands[0]?.interactive).toEqual(interactive);
    }
  });
  it("lets an owned process mark stop or prepare interactive when it has a status command", () => {
    for (const interactive of [{ stop: true }, { prepare: true }])
      expect(withCommands({ ...owned, status: "check", interactive }).success).toBe(true);
  });
  it("refuses an interactive start or afterJoin unless the rank is an external service", () => {
    for (const interactive of [{ start: true }, { afterJoin: true }]) {
      const parsed = withCommands({
        ...owned,
        afterJoin: "after",
        status: "check",
        interactive,
      });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.map((i) => i.path.at(-1))).toContain("management");
    }
  });
  it("refuses any interactive command without a status command", () => {
    for (const interactive of [{ stop: true }, { prepare: true }]) {
      const parsed = withCommands({ ...owned, interactive });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.map((i) => i.path.at(-1))).toContain("status");
    }
  });
  it("refuses an interactive phase the rank has no command for", () => {
    const { prepare: _prepare, afterJoin: _afterJoin, ...bare } = external;
    expect(withCommands({ ...bare, interactive: { prepare: true } }).success).toBe(false);
    expect(withCommands({ ...bare, interactive: { afterJoin: true } }).success).toBe(false);
  });
  it("never lets status or health be interactive, and takes only literal true", () => {
    for (const interactive of [
      { status: true },
      { health: true },
      { start: false },
      { start: "yes" },
      { unknown: true },
    ])
      expect(
        withCommands({ ...external, health: "curl", interactive }).success,
        JSON.stringify(interactive),
      ).toBe(false);
  });
  it("the stored schema reads the field without the save-time rules", () => {
    const stored = storedDeploymentVariantSchema.safeParse({
      ...base,
      commands: [{ ...owned, interactive: { start: true, stop: true } }],
    });
    expect(stored.success).toBe(true);
    expect(stored.data?.commands[0]?.interactive).toEqual({ start: true, stop: true });
    expect(
      storedDeploymentVariantSchema.safeParse({
        ...base,
        commands: [{ ...owned, interactive: { health: true } }],
      }).success,
    ).toBe(false);
  });
});

describe("interactive flags that never take effect (IC1-3)", () => {
  const entry = (interactive: Record<string, boolean>, extra: Record<string, string> = {}) => ({
    start: "start",
    stop: "stop",
    interactive,
    ...extra,
  });
  it("single node: prepare and afterJoin never run; start and stop do", () => {
    expect(
      unusedInteractiveFlags({
        key: "v",
        groupSize: 1,
        commands: [
          entry(
            { start: true, stop: true, prepare: true, afterJoin: true },
            { prepare: "p", afterJoin: "a" },
          ),
        ],
      }),
    ).toEqual([
      { variant: "v", rank: null, command: "prepare", reason: "single_node" },
      { variant: "v", rank: null, command: "afterJoin", reason: "single_node" },
    ]);
  });
  it("multi-node: the head's afterJoin replaces its start; workers run no prepare", () => {
    expect(
      unusedInteractiveFlags({
        key: "v",
        groupSize: 2,
        commands: [
          entry({ start: true, prepare: true }, { afterJoin: "a", prepare: "p" }),
          entry({ start: true, prepare: true, afterJoin: true }, { prepare: "p", afterJoin: "a" }),
        ],
      }),
    ).toEqual([
      { variant: "v", rank: 0, command: "start", reason: "after_join_replaces_start" },
      { variant: "v", rank: 1, command: "prepare", reason: "not_head" },
      { variant: "v", rank: 1, command: "afterJoin", reason: "not_head" },
    ]);
  });
  it("a shared entry counts as used when any rank uses it; a flag without its command is inert", () => {
    expect(
      unusedInteractiveFlags({
        key: "v",
        groupSize: 2,
        commands: [entry({ start: true, prepare: true, afterJoin: true }, { afterJoin: "a" })],
      }),
    ).toEqual([{ variant: "v", rank: null, command: "prepare", reason: "no_command" }]);
  });
});
