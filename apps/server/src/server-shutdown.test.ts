import { EventEmitter } from "node:events";
import type { StatementBoundedPrismaClient } from "@ws-model-proxy/db/client-factory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runProcessShutdown } from "./graceful-shutdown.js";
import { installServerShutdown, type ServerShutdownDeps } from "./server-shutdown.js";

type Harness = {
  events: string[];
  signals: EventEmitter;
  exits: number[];
  deps: ServerShutdownDeps;
  sweepJoin: { resolve: () => void };
};

/**
 * Fakes for every dependency; each records what it was asked to do in
 * `events`, in order. The real graceful sequence, drain and database step run
 * on top of them; only the process exit is injected.
 */
function harness(overrides: Partial<ServerShutdownDeps> = {}): Harness {
  const events: string[] = [];
  const exits: number[] = [];
  const signals = new EventEmitter();
  const record =
    (name: string) =>
    (..._args: unknown[]) => {
      events.push(name);
    };
  const sweepJoin: { resolve: () => void } = { resolve: () => {} };
  const sweepStopped = new Promise<void>((resolve) => {
    sweepJoin.resolve = () => {
      events.push("sweep:joined");
      resolve();
    };
  });
  const sweepClient = {
    prisma: {
      $disconnect: async () => {
        events.push("sweep:disconnect");
      },
    },
    quarantine: () => {
      events.push("sweep:quarantine");
      return 0;
    },
  } as unknown as StatementBoundedPrismaClient;
  const deps: ServerShutdownDeps = {
    periodicJobStops: [record("stop:media"), undefined, record("stop:retention")],
    stopUserDeletionSweep: () => {
      events.push("sweep:stop");
      return sweepStopped;
    },
    userDeletionSweepClient: sweepClient,
    relaySessions: {
      dispose: record("relay:dispose"),
      beginDrain: record("relay:beginDrain"),
      closeIdleRelaySessions: record("relay:closeIdle"),
      closeRelaySessions: record("relay:close"),
    },
    terminalHub: { closeAll: record("terminals:closeAll") },
    server: {
      close: (callback) => {
        events.push("http:close");
        callback();
      },
    },
    capacityLifecycle: {
      stopMaintenance: async () => {
        events.push("capacity:stopMaintenance");
      },
      close: async () => {
        events.push("capacity:close");
      },
    },
    closeDiagnosticsCapacityRuntime: async () => {
      events.push("diagnostics:close");
    },
    mcpAdmissionGate: {
      close: async () => {
        events.push("mcp:gate");
        // The sweep's tick settles once the fence is armed.
        sweepJoin.resolve();
      },
    },
    mcpHandler: {
      close: async () => {
        events.push("mcp:handler");
      },
    },
    shared: {
      $disconnect: async () => {
        events.push("shared:disconnect");
      },
    },
    signals,
    log: () => undefined,
    runProcessShutdown: (processDeps) =>
      runProcessShutdown({
        ...processDeps,
        exit: (code) => {
          exits.push(code);
          events.push(`exit:${code}`);
        },
        log: () => undefined,
      }),
    ...overrides,
  };
  return { events, signals, exits, deps, sweepJoin };
}

async function settled(events: string[]): Promise<void> {
  await vi.waitFor(() => expect(events.some((event) => event.startsWith("exit:"))).toBe(true));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("installServerShutdown", () => {
  it("SIGTERM runs the whole sequence in order and exits 0 through the watchdog path", async () => {
    const h = harness();
    installServerShutdown(h.deps);
    h.signals.emit("SIGTERM");
    await settled(h.events);
    expect(h.events).toEqual([
      // 1. periodic jobs: every job, the sweep's stop flag, relay timers,
      //    capacity maintenance only.
      "stop:media",
      "stop:retention",
      "sweep:stop",
      "relay:dispose",
      "capacity:stopMaintenance",
      // 2. browser sockets, after the drain flag refuses new terminal upgrades.
      "relay:beginDrain",
      "terminals:closeAll",
      // 3. drain: admission stops first, then idle CLI sockets close.
      "relay:beginDrain",
      "http:close",
      "relay:closeIdle",
      // 4. relay close.
      "relay:close",
      // 5. both capacity runtimes, once each.
      "capacity:close",
      "diagnostics:close",
      // 6. MCP: gate (arms the DB fence) and handler.
      "mcp:gate",
      "sweep:joined",
      "mcp:handler",
      // 7. the sweep's bounded shutdown (it joined in time: no quarantine),
      //    then the shared client.
      "sweep:disconnect",
      "shared:disconnect",
      "exit:0",
    ]);
    expect(h.exits).toEqual([0]);
  });

  it("SIGINT is handled the same way", async () => {
    const h = harness();
    installServerShutdown(h.deps);
    h.signals.emit("SIGINT");
    await settled(h.events);
    expect(h.exits).toEqual([0]);
    expect(h.events.at(-2)).toBe("shared:disconnect");
  });

  it("arms the watchdog synchronously on the signal, before any step is awaited", () => {
    const h = harness();
    const armed: string[] = [];
    const runProcess = vi.fn((deps: Parameters<typeof runProcessShutdown>[0]) => {
      // Nothing has run yet when the watchdog is armed.
      armed.push(`armed after ${h.events.length} events`);
      return runProcessShutdown({ ...deps, exit: () => undefined, log: () => undefined });
    });
    installServerShutdown({ ...h.deps, runProcessShutdown: runProcess });
    h.signals.emit("SIGTERM");
    expect(runProcess).toHaveBeenCalledTimes(1);
    expect(armed).toEqual(["armed after 0 events"]);
  });

  it("ignores a second signal", async () => {
    const h = harness();
    const runProcess = vi.fn(h.deps.runProcessShutdown);
    installServerShutdown({ ...h.deps, runProcessShutdown: runProcess });
    h.signals.emit("SIGTERM");
    h.signals.emit("SIGINT");
    h.signals.emit("SIGTERM");
    await settled(h.events);
    expect(runProcess).toHaveBeenCalledTimes(1);
    expect(h.events.filter((event) => event === "shared:disconnect")).toHaveLength(1);
    expect(h.exits).toEqual([0]);
  });

  it("hands the sweep join from the job stop to the database step instead of stopping it again", async () => {
    const h = harness();
    const stop = vi.fn(h.deps.stopUserDeletionSweep);
    const shutDownSweep = vi.fn<NonNullable<ServerShutdownDeps["shutDownUserDeletionSweep"]>>(
      async ({ stopped, client }) => {
        await stopped();
        expect(client).toBe(h.deps.userDeletionSweepClient);
        return { joined: true, quarantined: null, disconnected: true };
      },
    );
    installServerShutdown({
      ...h.deps,
      stopUserDeletionSweep: stop,
      shutDownUserDeletionSweep: shutDownSweep,
    });
    h.signals.emit("SIGTERM");
    await settled(h.events);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(shutDownSweep).toHaveBeenCalledTimes(1);
    expect(h.events.indexOf("sweep:joined")).toBeLessThan(h.events.indexOf("shared:disconnect"));
  });

  it("runs the sweep shutdown before the shared disconnect, which still runs when the sweep shutdown fails", async () => {
    const h = harness({
      shutDownUserDeletionSweep: async () => {
        h.events.push("sweep:shutdown-failed");
        throw new Error("boom");
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    installServerShutdown(h.deps);
    h.signals.emit("SIGTERM");
    await settled(h.events);
    expect(h.events.slice(-3)).toEqual(["sweep:shutdown-failed", "shared:disconnect", "exit:0"]);
  });

  it("stops capacity maintenance before the drain and closes the runtimes only after it", async () => {
    const h = harness();
    installServerShutdown(h.deps);
    h.signals.emit("SIGTERM");
    await settled(h.events);
    const at = (event: string) => h.events.indexOf(event);
    expect(at("capacity:stopMaintenance")).toBeLessThan(at("http:close"));
    expect(at("capacity:close")).toBeGreaterThan(at("relay:closeIdle"));
    expect(at("capacity:close")).toBeLessThan(at("mcp:gate"));
    expect(h.events.filter((event) => event === "capacity:close")).toHaveLength(1);
    expect(h.events.filter((event) => event === "diagnostics:close")).toHaveLength(1);
  });

  it("waits for a periodic job stop's join before the drain starts", async () => {
    const h = harness();
    let releaseJoin: () => void = () => undefined;
    const join = new Promise<void>((resolve) => {
      releaseJoin = () => {
        h.events.push("relayMaintenance:joined");
        resolve();
      };
    });
    installServerShutdown({
      ...h.deps,
      periodicJobStops: [
        () => {
          h.events.push("relayMaintenance:stop");
          return join;
        },
      ],
    });
    h.signals.emit("SIGTERM");
    // Every stop and capacity maintenance ran, but the step still waits.
    await vi.waitFor(() => expect(h.events).toContain("capacity:stopMaintenance"));
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    expect(h.events).not.toContain("terminals:closeAll");
    expect(h.events).not.toContain("http:close");
    releaseJoin();
    await settled(h.events);
    const at = (event: string) => h.events.indexOf(event);
    expect(at("relayMaintenance:stop")).toBeLessThan(at("sweep:stop"));
    expect(at("relayMaintenance:joined")).toBeLessThan(at("terminals:closeAll"));
    expect(h.exits).toEqual([0]);
  });

  it("tolerates missing optional runtimes (no capacity lifecycle, no MCP handler)", async () => {
    const h = harness({ capacityLifecycle: null, mcpHandler: null });
    installServerShutdown(h.deps);
    h.signals.emit("SIGTERM");
    await settled(h.events);
    expect(h.exits).toEqual([0]);
    expect(h.events).toContain("diagnostics:close");
    expect(h.events).toContain("shared:disconnect");
  });
});
