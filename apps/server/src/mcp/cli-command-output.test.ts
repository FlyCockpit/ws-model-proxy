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
  formatBoundedStream,
  presentCliCommand,
  redactCredentialSubstrings,
} = await import("./cli-command-output");

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
