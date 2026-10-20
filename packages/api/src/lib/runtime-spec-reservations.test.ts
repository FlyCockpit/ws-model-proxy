import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json";
import { reservationClaim, reservationsKey } from "./reservations";
import { runtimeLaunchHash } from "./runtime-launch-hash";
import {
  authoredRuntimeSpecSchema,
  nodeRuntimeSpec,
  RUNTIME_RESERVATIONS_MAX,
  type RuntimeSpec,
  runtimeSpecSchema,
} from "./runtime-spec";

function service(launch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    launch: {
      management: "service",
      groupSize: 1,
      resources: [{ kind: "unified", memoryGb: 100 }],
      labels: ["ds-head"],
      commands: [
        {
          start: "spark-ds41f up",
          stop: "spark-ds41f down",
          status: "spark-ds41f status",
        },
      ],
      health: { intervalMs: 30000, failureThreshold: 3, successThreshold: 1 },
      ...launch,
    },
  };
}

const WORKER = { labels: ["ds-worker"], resources: { kind: "unified", memoryGb: 100 } };

function issueIds(spec: unknown): Array<[string, string | undefined]> {
  const parsed = authoredRuntimeSpecSchema.safeParse(spec);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => [
        issue.path.join("."),
        (issue as { params?: { i18n?: string } }).params?.i18n,
      ]);
}

describe("launch.reservations", () => {
  it("accepts reservations on a single-node runtime", () => {
    expect(issueIds(service({ reservations: [WORKER, WORKER] }))).toEqual([]);
  });

  it("parses a spec without reservations exactly as before (no field added)", () => {
    const spec = service();
    const parsed = runtimeSpecSchema.parse(spec);
    expect(parsed.launch && "reservations" in parsed.launch).toBe(false);
    expect(canonicalJson(parsed)).toBe(canonicalJson(spec));
  });

  it("refuses reservations on a multi-node runtime", () => {
    expect(
      issueIds(
        service({
          groupSize: 2,
          resources: [{ kind: "unified", memoryGb: 100 }],
          fabric: undefined,
          reservations: [WORKER],
        }),
      ),
    ).toEqual([["launch.reservations", "reservationsGroup"]]);
    // An empty list says nothing: allowed anywhere.
    expect(issueIds(service({ groupSize: 2, reservations: [] }))).toEqual([]);
  });

  it("refuses a reservation without labels", () => {
    expect(issueIds(service({ reservations: [{ ...WORKER, labels: [] }] }))).toEqual([
      ["launch.reservations.0.labels", "reservationLabels"],
    ]);
  });

  it("refuses more than the maximum, bad labels and unknown fields", () => {
    const many = Array.from({ length: RUNTIME_RESERVATIONS_MAX + 1 }, () => WORKER);
    expect(issueIds(service({ reservations: many }))[0]?.[0]).toBe("launch.reservations");
    expect(issueIds(service({ reservations: [{ ...WORKER, labels: ["Bad"] }] }))).not.toEqual([]);
    expect(issueIds(service({ reservations: [{ ...WORKER, nodeId: "n1" }] }))).not.toEqual([]);
    expect(
      issueIds(service({ reservations: [{ ...WORKER, resources: { kind: "unified" } }] })),
    ).not.toEqual([]);
  });
});

describe("the node's copy and the launch hash", () => {
  it("strips reservations from what nodes see, and hashes that", () => {
    const withReservations = runtimeSpecSchema.parse(service({ reservations: [WORKER] }));
    const without = runtimeSpecSchema.parse(service());
    expect(nodeRuntimeSpec(withReservations)).toEqual(without);
    expect(runtimeLaunchHash(withReservations)).toBe(runtimeLaunchHash(without));
    // A spec without reservations is untouched (same object, same hash as before).
    expect(nodeRuntimeSpec(without)).toBe(without);
  });

  it("compares reservations separately (a version update needs a restart for them)", () => {
    expect(reservationsKey(service({ reservations: [WORKER] }))).not.toBe(
      reservationsKey(service()),
    );
    expect(reservationsKey(service())).toBe(reservationsKey(service({ reservations: [] })));
    expect(reservationsKey({ not: "a spec" })).toBe("[]");
  });

  it("leaves always-on specs alone", () => {
    const spec: RuntimeSpec = runtimeSpecSchema.parse({
      api: "openai",
      engine: "vllm",
      modelType: "llm",
      address: { baseUrl: "http://127.0.0.1:8000" },
    });
    expect(nodeRuntimeSpec(spec)).toBe(spec);
  });
});

describe("a reservation's claim", () => {
  it("is its instance's rank claim", () => {
    expect(reservationClaim([{ claim: "HELD" }])).toBe("HELD");
    expect(reservationClaim([{ claim: "HELD_UNKNOWN" }])).toBe("HELD_UNKNOWN");
    expect(reservationClaim([{ claim: "RELEASED" }])).toBe("RELEASED");
    expect(reservationClaim([])).toBe("RELEASED");
  });
});
