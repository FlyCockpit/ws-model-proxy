import { describe, expect, it, vi } from "vitest";

/**
 * The per-op credential gate of the file-tool core (`requireFilePat`), driven
 * directly: a read-only PAT (allowCliFileRead + mcp:read, no allowCliCommands)
 * may run the four read-class tools and must see the same unknown-tool answer
 * for every write-class tool as a credential that may not see the tool at all.
 * The wrapper-level tests in tools.test.ts cover the advertised surface; this
 * pins the core's own classification of each op.
 */

const fileRuntime = vi.hoisted(() => ({ runFileOp: vi.fn() }));

vi.mock("../relay/cli-file-ops.js", () => ({
  runFileOp: fileRuntime.runFileOp,
  cancelFileOpsForToken: vi.fn(),
  sweepExpiredFileOps: vi.fn(),
}));

const { FILE_TOOLS, McpCliFileError, runForwarderCliFileTool } = await import(
  "./cli-file-tools.js"
);

const READ_RESULT = {
  etag: "h:AAAAAAAAAAAAAAAAAAAAAA",
  size: 3,
  mtime: "2026-01-01T00:00:00Z",
  mode: "0644",
  totalLines: 1,
  startLine: 1,
  endLine: 1,
  eol: "lf" as const,
  text: "1|a",
  redactions: 0,
  more: null,
  secretFile: false,
};

const READ_ONLY_PAT = {
  kind: "pat" as const,
  tokenId: "token-read-only",
  allowCliCommands: false,
  allowCliFileRead: true,
  scopes: ["mcp:read"],
  expiresAt: null,
};

const WRITE_PAT = {
  ...READ_ONLY_PAT,
  allowCliCommands: true,
  scopes: ["mcp:write"],
};

const WRITE_ARGS: Readonly<Record<string, Record<string, unknown>>> = {
  edit: {
    path: "~/a",
    expectedEtag: "h:AAAAAAAAAAAAAAAAAAAAAA",
    edits: [{ oldText: "a", newText: "b" }],
  },
  write: { path: "~/a", content: "hello" },
  rename: { from: "~/a", to: "~/b" },
  mkdir: { path: "~/d" },
  delete: { path: "~/a" },
};

const WRITE_RESULTS: Readonly<Record<string, Record<string, unknown>>> = {
  edit: {
    etag: "h:AAAAAAAAAAAAAAAAAAAAAA",
    previousEtag: "h:BBBBBBBBBBBBBBBBBBBBBB",
    added: 1,
    removed: 1,
    applied: true,
  },
  write: { etag: "h:AAAAAAAAAAAAAAAAAAAAAA", size: 5, created: true },
  rename: { etag: null },
  mkdir: { created: true },
  delete: {
    deleted: true,
    type: "file",
    recovered: ["/workspace/.wsmp-recover-a1b2c3d4e5"],
  },
};

const READ_OPS: Array<[string, string, Record<string, unknown>]> = [
  ["forwarder_cli_file_read", "read", { path: "~/a" }],
  ["forwarder_cli_file_stat", "stat", { paths: ["~/a"] }],
  ["forwarder_cli_dir_list", "list", { path: "~/" }],
  ["forwarder_cli_file_search", "search", { root: "~/", pattern: "x" }],
];

const WRITE_OPS: Array<[string, string]> = FILE_TOOLS.filter(
  (tool) => !READ_OPS.some(([, op]) => op === tool.op),
).map((tool) => [tool.name, tool.op] as [string, string]);

function deps(credential: typeof READ_ONLY_PAT | typeof WRITE_PAT) {
  return { userId: "user-id", credential };
}

describe("requireFilePat op classification", () => {
  it("covers all nine tools: four read ops and five write ops", () => {
    expect(READ_OPS.map(([, op]) => op).sort()).toEqual(["list", "read", "search", "stat"]);
    expect(WRITE_OPS.map(([, op]) => op).sort()).toEqual([
      "delete",
      "edit",
      "mkdir",
      "rename",
      "write",
    ]);
    expect(FILE_TOOLS).toHaveLength(9);
  });

  it.each(READ_OPS)(
    "%s succeeds with a read-only PAT and passes op+args",
    async (name, op, args) => {
      fileRuntime.runFileOp.mockReset();
      fileRuntime.runFileOp.mockResolvedValue({ ok: true, op, result: READ_RESULT });
      const outcome = await runForwarderCliFileTool(
        op as never,
        { cliDeviceId: "cli-1", ...args },
        deps(READ_ONLY_PAT),
      );
      expect(outcome).toMatchObject({ ok: true, op });
      expect(fileRuntime.runFileOp).toHaveBeenCalledOnce();
      expect(fileRuntime.runFileOp.mock.calls[0]?.[0]).toMatchObject({
        userId: "user-id",
        tokenId: "token-read-only",
        cliDeviceId: "cli-1",
        op,
      });
      expect(name).toContain("forwarder_cli");
    },
  );

  it.each(WRITE_OPS)(
    "%s is the unknown-tool not-found for a read-only PAT and never calls the runtime",
    async (_name, op) => {
      fileRuntime.runFileOp.mockReset();
      fileRuntime.runFileOp.mockResolvedValue({ ok: true, op, result: WRITE_RESULTS[op] });
      const input = { cliDeviceId: "cli-1", ...WRITE_ARGS[op] };
      const error = await runForwarderCliFileTool(op as never, input, deps(READ_ONLY_PAT)).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(McpCliFileError);
      expect((error as InstanceType<typeof McpCliFileError>).code).toBe("not_found");
      expect((error as Error).message).toBe("CLI device not found");
      expect(fileRuntime.runFileOp).not.toHaveBeenCalled();
    },
  );

  it.each(WRITE_OPS)("%s runs for the command+write PAT", async (_name, op) => {
    fileRuntime.runFileOp.mockReset();
    fileRuntime.runFileOp.mockResolvedValue({ ok: true, op, result: WRITE_RESULTS[op] });
    const outcome = await runForwarderCliFileTool(
      op as never,
      { cliDeviceId: "cli-1", ...WRITE_ARGS[op] },
      deps(WRITE_PAT),
    );
    expect(outcome).toEqual({ ok: true, op, result: WRITE_RESULTS[op] });
    expect(fileRuntime.runFileOp).toHaveBeenCalledOnce();
  });

  it("refuses every op for a credential that may not see the tools at all", async () => {
    fileRuntime.runFileOp.mockReset();
    for (const credential of [
      { ...READ_ONLY_PAT, allowCliFileRead: false },
      { ...READ_ONLY_PAT, scopes: [] },
      { ...READ_ONLY_PAT, scopes: ["mcp:write"] },
      { kind: "oauth" as const },
    ]) {
      for (const [op, args] of [
        ...READ_OPS.map(([, op, args]) => [op, args] as const),
        ...WRITE_OPS.map(([, op]) => [op, WRITE_ARGS[op]] as const),
      ]) {
        const error = await runForwarderCliFileTool(
          op as never,
          { cliDeviceId: "cli-1", ...args },
          { userId: "user-id", credential },
        ).then(
          () => null,
          (thrown: unknown) => thrown,
        );
        expect(error).toBeInstanceOf(McpCliFileError);
        expect((error as InstanceType<typeof McpCliFileError>).code).toBe("not_found");
      }
    }
    expect(fileRuntime.runFileOp).not.toHaveBeenCalled();
  });
});

describe("e2e file-tools-relay script literals", () => {
  // scripts/e2e/file-tools-relay.mjs needs PostgreSQL and real binaries, so its
  // hard-coded message patterns are pinned here against the server constants.
  it("matches the server's upgrade messages and canonical protocol declaration", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join, resolve } = await import("node:path");
    const { RELAY_MIN_PROTOCOL_VERSION, RELAY_PROTOCOL_VERSIONS, RELAY_UPGRADE_REQUIRED_MESSAGE } =
      await import("../relay/protocol.js");
    const root = resolve(import.meta.dirname, "../../../..");
    const script = await readFile(join(root, "scripts/e2e/file-tools-relay.mjs"), "utf8");
    const versionSource = await readFile(
      join(root, "packages/api/src/lib/relay-protocol-version.ts"),
      "utf8",
    );

    // The script derives the protocol exactly this way.
    const scriptProtocolPattern = /const currentProtocol = \/(.+)\/\.exec\(versionSource\)/.exec(
      script,
    )?.[1];
    expect(scriptProtocolPattern).toBeDefined();
    const currentProtocol = new RegExp(scriptProtocolPattern ?? "^$").exec(versionSource)?.[1];
    expect(currentProtocol).toBe(RELAY_PROTOCOL_VERSIONS.at(-1));
    expect(currentProtocol).toBe(RELAY_MIN_PROTOCOL_VERSION);

    // The scripted 2.3 hello's protocol.error and the real old-binary output.
    // The script's own template literal, spelled without a placeholder here.
    const scriptTemplate = ["`relay protocol $", "{currentProtocol}`"].join("");
    expect(script).toContain(`upgradeMessage.message.includes(${scriptTemplate})`);
    expect(script).toContain(`oldLog.includes(${scriptTemplate})`);
    expect(RELAY_UPGRADE_REQUIRED_MESSAGE).toContain(`relay protocol ${currentProtocol}`);
    const upgradeLiteral = /assert\.match\(upgradeMessage\.message, \/([^/]+)\/([a-z]*)\)/.exec(
      script,
    );
    expect(upgradeLiteral).not.toBeNull();
    expect(RELAY_UPGRADE_REQUIRED_MESSAGE).toMatch(
      new RegExp(upgradeLiteral?.[1] ?? "^$", upgradeLiteral?.[2]),
    );

    // The file tool's refusal for a device that connected at relay 2.3.
    const toolLiteral = /assert\.match\(upgrade\.text, \/([^/]+)\/([a-z]*)\)/.exec(script);
    expect(toolLiteral).not.toBeNull();
    expect(script).toContain('protocolVersion: "2.3"');
    const refusal = new McpCliFileError({
      ok: false,
      code: "upgrade_required",
      rejectedProtocolVersion: "2.3",
    });
    expect(refusal.code).toBe("upgrade_required");
    expect(refusal.message).toMatch(new RegExp(toolLiteral?.[1] ?? "^$", toolLiteral?.[2]));
    expect(script).toContain('assert.equal(upgrade.error.code, "upgrade_required")');
  });
});
