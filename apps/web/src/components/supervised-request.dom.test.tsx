// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { TerminalTab } from "@/hooks/use-terminal-sessions";

const state = vi.hoisted(() => ({
  payloads: [] as unknown[],
  fail: null as null | { code: string; status: number },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // The requester is the one interpolated value these tests look at.
    t: (key: string, values?: { requester?: string }) =>
      values?.requester === undefined ? key : `${key}:${values.requester}`,
  }),
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/utils/orpc", () => ({
  orpc: {
    supervisedCommands: {
      key: () => ["supervisedCommands"],
      submitOutput: {
        mutationOptions: (options?: Record<string, unknown>) => ({
          mutationFn: async (input: { output: string | null }) => {
            state.payloads.push(input);
            if (state.fail) throw Object.assign(new Error("failed"), state.fail);
            return {
              status: "exited",
              outputMode: input.output === null ? "redacted" : "reviewed",
            };
          },
          ...options,
        }),
      },
    },
  },
}));

import { AgentRequestPanel, ReviewOutputDialog, tabAwaitsReview } from "./supervised-request";

const encoder = new TextEncoder();
const CAPTURE = encoder.encode("\u001b[32mok\u001b[0m wsmp_cli_secret1");

function agentTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    localId: "local-1",
    terminalId: "term-1",
    cliDeviceId: "cli-1",
    cols: 80,
    rows: 24,
    phase: "live",
    approvalCode: null,
    rejectionReason: null,
    error: null,
    multiViewer: true,
    viewerId: "viewer-1",
    writer: "you",
    viewerCount: 1,
    ptyCols: null,
    ptyRows: null,
    opener: false,
    origin: "agent",
    supervised: {
      commandId: "Y29tbWFuZC1pZC0wMDAwMQ",
      status: "awaiting_output_review",
      requester: "laptop agent",
      reason: "<b>needs</b> sudo",
      command: "echo \u001b[31mhi",
      cwd: "/home/me",
      shareOutput: true,
      createdAt: null,
      expiresAt: null,
      exitCode: 0,
      signal: null,
    },
    decline: null,
    ending: null,
    reviewOutput: true,
    // The ANSI color is stripped: the dialog shows what the agent would get.
    reviewCapture: {
      head: CAPTURE,
      tail: new Uint8Array(),
      totalBytes: CAPTURE.byteLength,
    },
    exitCode: null,
    exitSignal: null,
    ...overrides,
  };
}

function renderDialog(tab: TerminalTab, onSettled = vi.fn()) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
    >
      <ReviewOutputDialog tab={tab} onSettled={onSettled} />
    </QueryClientProvider>,
  );
  return onSettled;
}

function textarea(): HTMLTextAreaElement {
  return screen.getByLabelText("dashboard:agentRequests.review.label") as HTMLTextAreaElement;
}

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  state.payloads = [];
  state.fail = null;
});

describe("ReviewOutputDialog", () => {
  it("prefills exactly the text the agent would receive", () => {
    renderDialog(agentTab());
    expect(textarea().value).toBe("ok [redacted]");
  });

  it("submits the edited text with edited=true, and undo restores the capture", async () => {
    const onSettled = renderDialog(agentTab());
    fireEvent.change(textarea(), { target: { value: "ok" } });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:agentRequests.review.undo" }));
    expect(textarea().value).toBe("ok [redacted]");
    fireEvent.change(textarea(), { target: { value: "only this" } });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:agentRequests.review.submit" }));
    await waitFor(() => expect(onSettled).toHaveBeenCalledWith("local-1"));
    expect(state.payloads).toEqual([
      { commandId: "Y29tbWFuZC1pZC0wMDAwMQ", output: "only this", edited: true },
    ]);
  });

  it("submits unchanged text with edited=false", async () => {
    const onSettled = renderDialog(agentTab());
    fireEvent.click(screen.getByRole("button", { name: "dashboard:agentRequests.review.submit" }));
    await waitFor(() => expect(onSettled).toHaveBeenCalled());
    expect(state.payloads).toEqual([
      { commandId: "Y29tbWFuZC1pZC0wMDAwMQ", output: "ok [redacted]", edited: false },
    ]);
  });

  it("redacts everything from the default button and from Esc", async () => {
    const onSettled = renderDialog(agentTab());
    const redact = screen.getByRole("button", { name: "dashboard:agentRequests.review.redact" });
    expect(document.activeElement).toBe(redact);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(onSettled).toHaveBeenCalled());
    expect(state.payloads).toEqual([
      { commandId: "Y29tbWFuZC1pZC0wMDAwMQ", output: null, edited: false },
    ]);
  });

  it("closes when another viewer already answered", async () => {
    state.fail = { code: "CONFLICT", status: 409 };
    const onSettled = renderDialog(agentTab());
    fireEvent.click(screen.getByRole("button", { name: "dashboard:agentRequests.review.redact" }));
    await waitFor(() => expect(onSettled).toHaveBeenCalledWith("local-1"));
  });

  it("stays open on other failures", async () => {
    state.fail = { code: "INTERNAL_SERVER_ERROR", status: 500 };
    const onSettled = renderDialog(agentTab());
    fireEvent.click(screen.getByRole("button", { name: "dashboard:agentRequests.review.redact" }));
    await waitFor(() => expect(state.payloads).toHaveLength(1));
    expect(onSettled).not.toHaveBeenCalled();
  });
});

describe("tabAwaitsReview", () => {
  it("needs a capture on a live agent tab whose command finished with review", () => {
    expect(tabAwaitsReview(agentTab())).toBe(true);
    expect(tabAwaitsReview(agentTab({ reviewCapture: null }))).toBe(false);
    expect(tabAwaitsReview(agentTab({ phase: "exited" }))).toBe(false);
    expect(tabAwaitsReview(agentTab({ origin: "user" }))).toBe(false);
  });
});

describe("AgentRequestPanel", () => {
  it("shows the request as plain text and offers the review checkbox only while it can apply", () => {
    const onToggle = vi.fn();
    const view = render(
      <AgentRequestPanel
        tab={agentTab({
          supervised: { ...(agentTab().supervised ?? ({} as never)), status: "awaiting_user" },
        })}
        onView={() => undefined}
        onReviewOutputChange={onToggle}
      />,
    );
    // Reason and command are text, never markup.
    expect(screen.getByText("<b>needs</b> sudo")).toBeTruthy();
    expect(document.querySelector("b")).toBeNull();
    // Escaped like the CLI confirm screen: controls show as \u{…}.
    expect(screen.getByText("echo \\u{1b}[31mhi")).toBeTruthy();
    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    expect(onToggle).toHaveBeenCalledWith(false);
    view.rerender(
      <AgentRequestPanel
        tab={agentTab()}
        onView={() => undefined}
        onReviewOutputChange={onToggle}
      />,
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("hides the checkbox when output is not shared", () => {
    render(
      <AgentRequestPanel
        tab={agentTab({
          supervised: {
            ...(agentTab().supervised ?? ({} as never)),
            status: "running",
            shareOutput: false,
          },
        })}
        onView={() => undefined}
        onReviewOutputChange={() => undefined}
      />,
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText("dashboard:agentRequests.outputPrivate")).toBeTruthy();
  });

  it("reports how the command finished", () => {
    render(
      <AgentRequestPanel
        tab={agentTab({ phase: "exited", exitCode: 3 })}
        onView={() => undefined}
        onReviewOutputChange={() => undefined}
      />,
    );
    expect(screen.getByText("dashboard:agentRequests.finished")).toBeTruthy();
  });

  it.each([
    ["declined", "dashboard:agentRequests.notRun.declined"],
    ["expired", "dashboard:agentRequests.notRun.expired"],
    ["rejected", "dashboard:agentRequests.notRun.rejected"],
    ["cancelled", "dashboard:agentRequests.cancelled"],
  ] as const)("says a %s request's command did not simply finish", (status, key) => {
    // The confirm child exits 0 on a decline; that is not "finished (exit 0)".
    render(
      <AgentRequestPanel
        tab={agentTab({
          phase: "exited",
          exitCode: 0,
          supervised: { ...(agentTab().supervised ?? ({} as never)), status },
        })}
        onView={() => undefined}
        onReviewOutputChange={() => undefined}
      />,
    );
    expect(screen.getByText(key)).toBeTruthy();
    expect(screen.queryByText("dashboard:agentRequests.finished")).toBeNull();
  });

  it("shows invisible and reordering characters escaped, like the CLI screen", () => {
    render(
      <AgentRequestPanel
        tab={agentTab({
          supervised: {
            ...(agentTab().supervised ?? ({} as never)),
            status: "awaiting_user",
            requester: "agent\u202e",
            reason: "safe\u200b cleanup",
            command: "echo \u202egnp.exe\nrm -rf \u2066x\u2069\udb40\udc41",
          },
        })}
        onView={() => undefined}
        onReviewOutputChange={() => undefined}
      />,
    );
    const text = document.body.textContent ?? "";
    for (const hidden of ["\u202e", "\u200b", "\u2066", "\u2069", "\udb40\udc41"]) {
      expect(text).not.toContain(hidden);
    }
    expect(
      screen.getByText("echo \\u{202e}gnp.exe\nrm -rf \\u{2066}x\\u{2069}\\u{e0041}", {
        normalizer: (value) => value,
      }),
    ).toBeTruthy();
    expect(screen.getByText("safe\\u{200b} cleanup")).toBeTruthy();
    expect(screen.getByText("dashboard:agentRequests.requestedBy:agent\\u{202e}")).toBeTruthy();
    expect(text).toContain("dashboard:agentRequests.commandSize");
  });
});
