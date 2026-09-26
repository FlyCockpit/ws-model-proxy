import { Client, type PoolConfig } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrismaClient, createStatementBoundedPrismaClient } from "./client-factory";
import "./index";

const { configs } = vi.hoisted(() => ({ configs: [] as PoolConfig[] }));

vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: class {
    constructor(config: PoolConfig) {
      configs.push(config);
    }
  },
}));
vi.mock("../prisma/generated/client", () => ({ PrismaClient: class {} }));
vi.mock("@ws-model-proxy/env/shared", () => ({
  env: { DATABASE_URL: "postgresql://localhost/test?options=-c%20TimeZone=Asia%2FTokyo" },
}));

// index.ts constructs the shared client through the same factory. No socket
// opens: capture adapter options and exercise the real onConnect callback.
const shared = configs[0];
createPrismaClient("postgresql://localhost/test?options=-c%20TimeZone=America%2FNew_York");
const independent = configs[1];
createPrismaClient("postgresql://localhost/test");
const defaultSettings = configs[2];
createStatementBoundedPrismaClient(
  "postgresql://localhost/test?options=-c%20TimeZone=Asia%2FTokyo",
  {
    statementTimeoutMs: 3_000,
    connectTimeoutMs: 3_000,
    applicationName: "utc-regression",
    maxConnections: 1,
    minIdleConnections: 0,
    keepAliveInitialDelayMs: 1_000,
  },
);
const bounded = configs[3];

afterEach(() => vi.restoreAllMocks());

describe.each([
  ["shared", shared],
  ["independent", independent],
  ["default settings", defaultSettings],
  ["statement-bounded", bounded],
] as const)("%s Prisma pool UTC enforcement", (_name, config) => {
  it("sets UTC at session level before checkout, including each replacement connection", async () => {
    expect(config?.onConnect).toBeTypeOf("function");
    expect(config?.connectionString).toContain("postgresql://localhost/test");
    for (let connection = 0; connection < 2; connection += 1) {
      const client = new Client();
      const query = vi.spyOn(client, "query").mockImplementation(async () => ({
        command: "SELECT",
        rowCount: 1,
        oid: 0,
        fields: [],
        rows: [
          { time_zone: "UTC", statement_timeout_ms: "3000", application_name: "utc-regression" },
        ],
      }));
      await config?.onConnect?.(client);
      expect(query).toHaveBeenNthCalledWith(
        1,
        "SELECT set_config('TimeZone', 'UTC', false) AS time_zone",
      );
      // Shared/independent clients retain their timeout/name configuration.
      expect(query).toHaveBeenCalledTimes(config === bounded ? 3 : 1);
      if (config === bounded) {
        expect(query).toHaveBeenNthCalledWith(
          2,
          "SELECT set_config('statement_timeout', $1, false), set_config('application_name', $2, false)",
          ["3000ms", "utc-regression"],
        );
      }
    }
  });

  it("fails checkout when UTC cannot be set or acknowledged", async () => {
    expect(config?.onConnect).toBeTypeOf("function");
    const client = new Client();
    const query = vi.spyOn(client, "query").mockRejectedValueOnce(new Error("connection lost"));
    await expect(config?.onConnect?.(client)).rejects.toThrow("connection lost");
    query.mockImplementation(async () => ({
      command: "SELECT",
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [{ time_zone: "Asia/Tokyo" }],
    }));
    await expect(config?.onConnect?.(client)).rejects.toThrow("UTC session setting");
  });

  it("does not complete initialization while the UTC setting is pending", async () => {
    expect(config?.onConnect).toBeTypeOf("function");
    const client = new Client();
    let rejectSetting!: (error: Error) => void;
    vi.spyOn(client, "query").mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSetting = reject;
        }),
    );
    let finished = false;
    const ready = Promise.resolve(config?.onConnect?.(client)).finally(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    const rejected = expect(ready).rejects.toThrow("initialization failed");
    rejectSetting(new Error("initialization failed"));
    await rejected;
  });
});
