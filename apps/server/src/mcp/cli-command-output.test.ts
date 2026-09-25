import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-thirty-two",
    NODE_ENV: "test",
  },
}));

vi.mock("@ws-model-proxy/env/shared", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-thirty-two",
    DATABASE_URL: "postgresql://cli-command-output-test",
    NODE_ENV: "test",
  },
}));

const { redactSecrets } = await import("./redaction");
const {
  CLI_COMMAND_WRAPPED_OUTPUT_BUDGET,
  CLI_OUTPUT_ELLIPSIS,
  CLI_STREAM_HEAD_MAX_BYTES,
  CLI_STREAM_TAIL_MAX_BYTES,
  CLI_OUTPUT_CREDENTIAL_PREFIXES,
  formatBoundedStream,
  presentCliCommand,
  presentSupervisedCommand,
  redactCredentialSubstrings,
} = await import("./cli-command-output");
const { PRODUCT_CREDENTIAL_PREFIXES } = await import("@ws-model-proxy/db/forwarder-security");

const text = (value: string) => new TextEncoder().encode(value);

describe("CLI command output formatting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("drops the overlapping prefix of tail when the retained bytes cover the stream", () => {
    const formatted = formatBoundedStream({
      head: text("HELL"),
      tail: text("HELLO"),
      totalBytes: 5,
    });
    expect(formatted).toEqual({ text: "HELLO", truncated: false, totalBytes: 5 });
  });

  it("concatenates head and tail when the retained bytes cover the stream", () => {
    const formatted = formatBoundedStream({
      head: text("HEAD"),
      tail: text("TAIL"),
      totalBytes: 8,
    });
    expect(formatted).toEqual({ text: "HEADTAIL", truncated: false, totalBytes: 8 });
  });

  it("inserts an ellipsis when the stream is longer than head plus tail", () => {
    const formatted = formatBoundedStream({
      head: text("HEAD"),
      tail: text("TAIL more"),
      totalBytes: 100,
    });
    expect(formatted.truncated).toBe(true);
    expect(formatted.totalBytes).toBe(100);
    expect(formatted.text).toBe(`HEAD${CLI_OUTPUT_ELLIPSIS} more`);
  });

  it("decodes lossy UTF-8 and strips control characters except newline, tab, and CR", () => {
    const formatted = formatBoundedStream({
      head: Uint8Array.of(0xff, 0x41, 0x00, 0x0a, 0x09, 0x0d, 0x07),
      tail: new Uint8Array(),
      totalBytes: 7,
    });
    expect(formatted.truncated).toBe(false);
    expect(formatted.text).toBe("\uFFFDA\n\t\r");
  });

  it("redacts credential substrings that whole-value redaction would keep", () => {
    const raw = "see wsmp_mcp_abc_DEF-1 and wsmp_model_zzz inside";
    expect(redactSecrets(raw)).toBe(raw);
    expect(redactCredentialSubstrings(raw)).toBe("see [redacted] and [redacted] inside");
    const formatted = formatBoundedStream({
      head: text(`prefix ${raw}`),
      tail: new Uint8Array(),
      totalBytes: text(`prefix ${raw}`).length,
    });
    expect(formatted.text).toContain("[redacted]");
    expect(formatted.text).not.toContain("wsmp_mcp_abc_DEF-1");
    expect(formatted.text).not.toContain("wsmp_model_zzz");
  });

  it("redacts a credential that was split by a stripped control character", () => {
    const formatted = formatBoundedStream({
      head: text("wsmp_cli_\u0000SECRET"),
      tail: new Uint8Array(),
      totalBytes: text("wsmp_cli_\u0000SECRET").length,
    });
    expect(formatted.text).toBe("[redacted]");
    expect(formatted.text).not.toContain("SECRET");
  });

  it("omits the exit code while running and ignores progress after exit", () => {
    const bytes = {
      head: text("out"),
      tail: new Uint8Array(),
      totalBytes: 3,
    };
    const running = presentCliCommand(
      {
        commandId: "cmd-1",
        status: "running",
        exitCode: null,
        processSignal: null,
        timedOut: false,
        rejectionReason: null,
        stdout: bytes,
        stderr: bytes,
      },
      false,
    );
    expect(running).toEqual({ commandId: "cmd-1", status: "running" });

    const finished = presentCliCommand(
      {
        commandId: "cmd-1",
        status: "exited",
        exitCode: 3,
        processSignal: 15,
        timedOut: true,
        rejectionReason: null,
        stdout: bytes,
        stderr: bytes,
      },
      false,
    );
    expect(finished).toMatchObject({
      commandId: "cmd-1",
      status: "exited",
      exitCode: 3,
      processSignal: 15,
      timedOut: true,
    });
  });

  it("keeps a max-size stream under the wrapped MCP output budget", () => {
    expect(CLI_STREAM_HEAD_MAX_BYTES).toBe(8192);
    expect(CLI_STREAM_TAIL_MAX_BYTES).toBe(40960);
    const stream = {
      head: new Uint8Array(CLI_STREAM_HEAD_MAX_BYTES).fill(0xff),
      tail: new Uint8Array(CLI_STREAM_TAIL_MAX_BYTES).fill(0xff),
      totalBytes: 5_000_000,
    };
    const record = presentCliCommand(
      {
        commandId: "c".repeat(32),
        status: "exited",
        exitCode: 1,
        processSignal: "SIGKILL",
        timedOut: true,
        rejectionReason: null,
        stdout: stream,
        stderr: stream,
      },
      undefined,
    );
    const serialized = JSON.stringify(record);
    const envelope = {
      content: [{ type: "text", text: serialized }],
      structuredContent: { result: record },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(envelope)).length;
    expect(bytes).toBeLessThanOrEqual(CLI_COMMAND_WRAPPED_OUTPUT_BUDGET);
    const stdout = record.stdout;
    expect(stdout?.truncated).toBe(true);
    expect(stdout?.totalBytes).toBe(5_000_000);
    expect(stdout?.text.startsWith("\uFFFD")).toBe(true);
    expect(stdout?.text.endsWith("\uFFFD")).toBe(true);
  });

  it("drops a leading token fragment from a truncated tail before redaction", () => {
    const formatted = formatBoundedStream({
      head: text("HEAD"),
      tail: text("mcp_leftover secret"),
      totalBytes: 100,
    });
    expect(formatted.text).not.toContain("mcp_leftover");
    expect(formatted.text).toContain("secret");
  });

  it("strips ANSI and OSC sequences from model-facing text", () => {
    const raw = "\u001b[31mred\u001b[0m\u001b]0;title\u0007ok";
    const formatted = formatBoundedStream({
      head: text(raw),
      tail: new Uint8Array(),
      totalBytes: text(raw).length,
    });
    expect(formatted.text).toBe("redok");
    expect(formatted.text).not.toContain("\u001b");
  });

  it("keeps both ends when a truncated stream is shrunk to the MCP budget", () => {
    const head = new Uint8Array(CLI_STREAM_HEAD_MAX_BYTES).fill(0xff);
    head.set(text("HEAD_MARKER"), 0);
    const tail = new Uint8Array(CLI_STREAM_TAIL_MAX_BYTES).fill(0xff);
    const marker = text("TAIL_MARKER");
    tail.set(marker, tail.length - marker.length);
    const stream = { head, tail, totalBytes: 5_000_000 };
    const record = presentCliCommand(
      {
        commandId: "cmd-shrink",
        status: "exited",
        exitCode: 0,
        processSignal: null,
        timedOut: false,
        rejectionReason: null,
        stdout: stream,
        stderr: stream,
      },
      undefined,
    );
    expect(record.stdout?.text).toContain("HEAD_MARKER");
    expect(record.stdout?.text).toContain("TAIL_MARKER");
  });

  it("keeps an exec rejection reason", () => {
    const bytes = { head: text("nope"), tail: new Uint8Array(), totalBytes: 4 };
    const record = presentCliCommand(
      {
        commandId: "cmd-1",
        status: "rejected",
        exitCode: null,
        processSignal: null,
        timedOut: false,
        rejectionReason: "bad_cwd",
        stdout: bytes,
        stderr: bytes,
      },
      undefined,
    );
    expect(record.rejectionReason).toBe("bad_cwd");
  });
});

describe("shared credential prefixes", () => {
  it("equal the product credential prefixes, so the browser review shows what the agent gets", () => {
    expect([...CLI_OUTPUT_CREDENTIAL_PREFIXES].sort()).toEqual(
      Object.values(PRODUCT_CREDENTIAL_PREFIXES).sort(),
    );
  });
});

describe("presentSupervisedCommand", () => {
  const base = {
    commandId: "sup-1",
    exitCode: null,
    signal: null,
    rejectionReason: null,
    waitDeadline: null,
    started: null,
    output: null,
    shared: null,
    reviewedText: null,
  };
  const capture = {
    head: text("SECRET_UNREVIEWED_OUTPUT"),
    tail: new Uint8Array(),
    totalBytes: 24,
  };

  it.each(["awaiting_user", "running", "awaiting_output_review"])(
    "carries only the status while %s, even if a capture is present",
    (status) => {
      const presented = presentSupervisedCommand({ ...base, status, shared: capture });
      expect(JSON.stringify(presented)).not.toContain("SECRET_UNREVIEWED_OUTPUT");
      expect(presented).not.toHaveProperty("stdout");
      expect(presented).toMatchObject({ commandId: "sup-1", kind: "supervised", status });
    },
  );

  it.each(["redacted", "private"] as const)("has no stdout for mode %s", (mode) => {
    const presented = presentSupervisedCommand({
      ...base,
      status: "exited",
      exitCode: 0,
      output: { mode, edited: false },
      shared: capture,
    });
    expect(presented).not.toHaveProperty("stdout");
    expect(JSON.stringify(presented)).not.toContain("SECRET_UNREVIEWED_OUTPUT");
    expect(presented).toMatchObject({ status: "exited", exitCode: 0, output: { mode } });
  });

  it("shows shared capture text and reviewed text with the edited flag", () => {
    const shared = presentSupervisedCommand({
      ...base,
      status: "exited",
      exitCode: 2,
      output: { mode: "shared", edited: false },
      shared: {
        head: text("\u001b[31mred\u001b[0m wsmp_cli_abc"),
        tail: new Uint8Array(),
        totalBytes: 24,
      },
    });
    expect(shared).toMatchObject({
      exitCode: 2,
      output: { mode: "shared", edited: false },
      stdout: { text: "red [redacted]", truncated: false },
    });
    const reviewed = presentSupervisedCommand({
      ...base,
      status: "exited",
      exitCode: 0,
      output: { mode: "reviewed", edited: true },
      reviewedText: "ok",
    });
    expect(reviewed).toMatchObject({
      output: { mode: "reviewed", edited: true },
      stdout: { text: "ok", truncated: false, totalBytes: 2 },
    });
  });

  it("reports why a request ended and whether its command had started", () => {
    expect(
      presentSupervisedCommand({
        ...base,
        status: "cancelled",
        rejectionReason: "cli_disconnected",
      }),
    ).toEqual({
      commandId: "sup-1",
      kind: "supervised",
      status: "cancelled",
      started: null,
      rejectionReason: "cli_disconnected",
    });
    expect(
      presentSupervisedCommand({
        ...base,
        status: "cancelled",
        rejectionReason: "token_revoked",
        started: true,
      }),
    ).toMatchObject({ status: "cancelled", started: true });
    expect(presentSupervisedCommand({ ...base, status: "expired", started: false })).toEqual({
      commandId: "sup-1",
      kind: "supervised",
      status: "expired",
      started: false,
    });
  });
});
