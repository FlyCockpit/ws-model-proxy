/**
 * Test-only: an in-memory stand-in for the Prisma delegates the self-update code uses (node,
 * nodeAgentUpdate, nodeAgentUpdateBatch, instanceRank, $transaction), with the two partial
 * unique indexes of the hardening (one update in flight per node, one running batch per owner).
 * Tests install it with `vi.mock("@ws-model-proxy/db", ...)`; nothing reaches a database.
 */
type Row = Record<string, unknown>;

function matches(row: Row, where: unknown): boolean {
  if (!where || typeof where !== "object") return true;
  for (const [key, condition] of Object.entries(where as Row)) {
    if (key === "OR") {
      if (!(condition as unknown[]).some((branch) => matches(row, branch))) return false;
      continue;
    }
    const value = row[key];
    if (condition === null) {
      if (value !== null && value !== undefined) return false;
      continue;
    }
    if (condition instanceof Date) {
      if (!(value instanceof Date) || value.getTime() !== condition.getTime()) return false;
      continue;
    }
    if (typeof condition === "object") {
      const ops = condition as Row;
      if ("in" in ops && !(ops.in as unknown[]).includes(value)) return false;
      if ("notIn" in ops && (ops.notIn as unknown[]).includes(value)) return false;
      const time = value instanceof Date ? value.getTime() : null;
      if ("lte" in ops && (time === null || time > (ops.lte as Date).getTime())) return false;
      if ("lt" in ops && (time === null || time >= (ops.lt as Date).getTime())) return false;
      if ("gte" in ops && (time === null || time < (ops.gte as Date).getTime())) return false;
      // A relation filter (`Node: { userId }`) on a row that carries the field itself.
      if (!["in", "notIn", "lte", "lt", "gte"].some((op) => op in ops) && !matches(row, ops))
        return false;
      continue;
    }
    if (value !== condition) return false;
  }
  return true;
}

function project(row: Row): Row {
  return { ...row };
}

class UniqueViolation extends Error {
  code = "P2002";
}

export function createAgentUpdateDb() {
  const tables = {
    node: [] as Row[],
    nodeAgentUpdate: [] as Row[],
    nodeAgentUpdateBatch: [] as Row[],
    instanceRank: [] as Row[],
  };
  let clock = 0;
  const stamp = () => new Date(Date.UTC(2026, 9, 28, 12, 0, 0) + clock++);

  function delegate(name: keyof typeof tables) {
    const list = () => tables[name];
    return {
      findFirst: async (args: { where?: unknown; orderBy?: unknown } = {}) => {
        const found = sorted(
          list().filter((row) => matches(row, args.where)),
          args.orderBy,
        );
        return found[0] ? project(found[0]) : null;
      },
      findMany: async (
        args: { where?: unknown; orderBy?: unknown; distinct?: string[]; take?: number } = {},
      ) => {
        let found = sorted(
          list().filter((row) => matches(row, args.where)),
          args.orderBy,
        );
        if (args.distinct) {
          const seen = new Set<string>();
          found = found.filter((row) => {
            const key = args.distinct?.map((field) => String(row[field])).join("|") ?? "";
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }
        return found.slice(0, args.take ?? found.length).map(project);
      },
      create: async (args: { data: Row }) => {
        const now = stamp();
        const row: Row = {
          createdAt: now,
          updatedAt: now,
          ...defaults(name),
          ...args.data,
        };
        if (row.id === undefined) row.id = `${name}-${list().length + 1}`;
        if (
          name === "nodeAgentUpdate" &&
          list().some((other) => other.nodeId === row.nodeId && other.endedAt === null)
        )
          throw new UniqueViolation("node_agent_update_one_active");
        if (
          name === "nodeAgentUpdateBatch" &&
          list().some((other) => other.userId === row.userId && other.state === "RUNNING")
        )
          throw new UniqueViolation("node_agent_update_batch_one_running");
        list().push(row);
        return project(row);
      },
      updateMany: async (args: { where?: unknown; data: Row }) => {
        let count = 0;
        for (const row of list())
          if (matches(row, args.where)) {
            Object.assign(row, args.data, { updatedAt: stamp() });
            count += 1;
          }
        return { count };
      },
      deleteMany: async (args: { where?: unknown } = {}) => {
        const before = list().length;
        tables[name] = list().filter((row) => !matches(row, args.where));
        return { count: before - tables[name].length };
      },
    };
  }

  function sorted(rows: Row[], orderBy: unknown): Row[] {
    if (!orderBy || typeof orderBy !== "object") return rows;
    const [[field, direction] = []] = Object.entries(orderBy as Record<string, string>);
    if (!field) return rows;
    const sign = direction === "desc" ? -1 : 1;
    return [...rows].sort((a, b) => {
      const x = a[field] instanceof Date ? (a[field] as Date).getTime() : String(a[field]);
      const y = b[field] instanceof Date ? (b[field] as Date).getTime() : String(b[field]);
      return x < y ? -sign : x > y ? sign : 0;
    });
  }

  function defaults(name: keyof typeof tables): Row {
    if (name === "nodeAgentUpdate")
      return { batchId: null, reason: null, detail: null, endedAt: null, deadlineAt: null };
    if (name === "nodeAgentUpdateBatch")
      return {
        state: "RUNNING",
        position: 0,
        currentNodeId: null,
        currentUpdateId: null,
        skippedNodeIds: [],
        stoppedNodeId: null,
        stoppedReason: null,
        endedAt: null,
      };
    return {};
  }

  const client = {
    node: delegate("node"),
    nodeAgentUpdate: delegate("nodeAgentUpdate"),
    nodeAgentUpdateBatch: delegate("nodeAgentUpdateBatch"),
    instanceRank: delegate("instanceRank"),
    // Atomic enough for tests: a failing callback rolls the tables back.
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      const snapshot = Object.fromEntries(
        Object.entries(tables).map(([key, rows]) => [key, rows.map((row) => ({ ...row }))]),
      ) as typeof tables;
      try {
        return await work(client);
      } catch (error) {
        Object.assign(tables, snapshot);
        throw error;
      }
    },
  };
  return { client, tables };
}

/** A node row as `AGENT_UPDATE_NODE_SELECT` reads it: online, Full, outdated, self-update able. */
export function nodeRow(overrides: Row = {}): Row {
  return {
    id: "node-1",
    userId: "owner-1",
    slug: "box-1",
    connection: "ONLINE",
    trust: "FULL",
    trustLowerRequestedAt: null,
    trustChangedAt: null,
    cliVersion: "0.4.2",
    cliBuild: { commit: null, installMethod: "script", target: "x86_64-unknown-linux-gnu" },
    environment: null,
    features: {
      selfUpdate: { strategies: ["self-replace"], instancesSurvive: true, remote: "allowed" },
    },
    agentUpdatePolicy: "ALLOWED",
    ...overrides,
  };
}
