// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

type Row = {
  id: string;
  cliDeviceId: string;
  kind: string;
  outcome: string;
  path: string;
  reason: string | null;
  bytes: number | null;
  startedAt: string;
};

const state = vi.hoisted(() => ({
  calls: [] as Array<{ cliDeviceId: string; limit: number; cursor?: string }>,
  respond: null as null | ((input: { cursor?: string }) => unknown),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));

vi.mock("@/utils/orpc", () => ({
  orpc: {
    cliAgentActivity: {
      list: {
        infiniteOptions: (options: {
          input: (cursor: string | undefined) => { cliDeviceId: string; limit: number };
          initialPageParam: string | undefined;
          getNextPageParam: (page: { nextCursor: string | null }) => string | undefined;
        }) => ({
          queryKey: ["cliAgentActivity", "list", options.input(undefined)],
          queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
            const input = options.input(pageParam) as {
              cliDeviceId: string;
              limit: number;
              cursor?: string;
            };
            state.calls.push(input);
            if (!state.respond) throw new Error("no response");
            return state.respond(input);
          },
          initialPageParam: options.initialPageParam,
          getNextPageParam: options.getNextPageParam,
        }),
      },
    },
  },
}));

import { CliAgentActivity, splitAuditPath } from "./cli-agent-activity";

const HASH = "a".repeat(64);

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "e1",
    cliDeviceId: "cli-1",
    kind: "command",
    outcome: "completed",
    path: `hmac-sha256:${HASH} make`,
    reason: "exit:0",
    bytes: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderIt() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CliAgentActivity cliDeviceId="cli-1" deviceName="Desk" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  state.calls = [];
  state.respond = null;
});

describe("CliAgentActivity", () => {
  it("does not read the log until the section is opened", async () => {
    state.respond = () => ({ events: [], nextCursor: null });
    renderIt();
    expect(state.calls).toEqual([]);
    const toggle = screen.getByRole("button", { name: /clis.activity.show/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(toggle);
    await waitFor(() => expect(state.calls).toEqual([{ cliDeviceId: "cli-1", limit: 20 }]));
    expect(
      screen.getByRole("button", { name: /clis.activity.hide/ }).getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("lists events with kind, outcome, program name, hash, reason and size", async () => {
    state.respond = () => ({
      events: [
        row(),
        row({
          id: "e2",
          kind: "file_write",
          outcome: "refused",
          path: "/etc/‮hosts",
          reason: null,
          bytes: 1234,
        }),
      ],
      nextCursor: null,
    });
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: /clis.activity.show/ }));
    const list = await screen.findByRole("list");
    expect(list.textContent).toContain("clis.activity.kinds.command");
    expect(list.textContent).toContain("clis.activity.outcomes.completed");
    expect(list.textContent).toContain(`clis.activity.program {"value":"make"}`);
    expect(list.textContent).toContain(`"value":"${"a".repeat(12)}"`);
    expect(list.textContent).not.toContain(HASH);
    expect(list.textContent).toContain("exit:0");
    expect(list.textContent).toContain("clis.activity.outcomes.refused");
    // Bidi controls in a path are shown escaped, not applied.
    expect(list.textContent).toContain("/etc/\\u{202e}hosts");
    expect(list.textContent).toContain("1,234");
  });

  it("renders a supervised_command row with its program and hash chip", async () => {
    state.respond = () => ({
      events: [
        row({
          id: "e4",
          kind: "supervised_command",
          outcome: "completed",
          path: `hmac-sha256:${HASH} make install`,
          reason: "exit:0",
        }),
      ],
      nextCursor: null,
    });
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: /clis.activity.show/ }));
    const list = await screen.findByRole("list");
    expect(list.textContent).toContain("clis.activity.kinds.supervised_command");
    // The stored path is decoded, not shown raw: program via the chip, the hex
    // hash truncated, and never the full digest.
    expect(list.textContent).toContain(`clis.activity.program {"value":"make install"}`);
    expect(list.textContent).toContain(`"value":"${"a".repeat(12)}"`);
    expect(list.textContent).not.toContain(HASH);
    expect(list.textContent).not.toContain(`hmac-sha256:${HASH}`);
  });

  it("shows the program without a hash chip when the digest is unavailable", async () => {
    state.respond = () => ({
      events: [row({ id: "e3", path: "hmac-sha256:unavailable ls" })],
      nextCursor: null,
    });
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: /clis.activity.show/ }));
    const list = await screen.findByRole("list");
    // The program is shown plainly (no "Program:" chip, like a file path), and
    // neither the sentinel nor the label leaks into the row.
    expect(list.textContent).toContain("ls");
    expect(list.textContent).not.toContain("commandHash");
    expect(list.textContent).not.toContain("unavailable");
  });

  it("shows the empty state", async () => {
    state.respond = () => ({ events: [], nextCursor: null });
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: /clis.activity.show/ }));
    expect(await screen.findByText("clis.activity.empty")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("shows an error with a retry that reads again", async () => {
    state.respond = () => {
      throw new Error("boom");
    };
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: /clis.activity.show/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("clis.activity.loadFailed");
    state.respond = () => ({ events: [row()], nextCursor: null });
    await userEvent.click(screen.getByRole("button", { name: "common:actions.tryAgain" }));
    expect(await screen.findByRole("list")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("loads the next page with the server cursor and hides the button at the end", async () => {
    state.respond = (input) =>
      input.cursor === undefined
        ? { events: [row({ id: "e1" })], nextCursor: "cursor-1" }
        : { events: [row({ id: "e2", path: `hmac-sha256:${HASH} second` })], nextCursor: null };
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: /clis.activity.show/ }));
    await userEvent.click(await screen.findByRole("button", { name: "clis.activity.loadMore" }));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    expect(state.calls[1]).toEqual({ cliDeviceId: "cli-1", limit: 20, cursor: "cursor-1" });
    expect(screen.queryByRole("button", { name: "clis.activity.loadMore" })).toBeNull();
  });
});

describe("splitAuditPath", () => {
  it("splits only command kinds and only a well-formed keyed-hash prefix", () => {
    expect(splitAuditPath("command", `hmac-sha256:${HASH} pwd`)).toEqual({
      hash: "a".repeat(12),
      text: "pwd",
    });
    expect(splitAuditPath("supervised_command", `hmac-sha256:${HASH} make`)).toEqual({
      hash: "a".repeat(12),
      text: "make",
    });
    expect(splitAuditPath("file_read", `hmac-sha256:${HASH} pwd`)).toEqual({
      hash: null,
      text: `hmac-sha256:${HASH} pwd`,
    });
    expect(splitAuditPath("command", "hmac-sha256:short pwd")).toEqual({
      hash: null,
      text: "hmac-sha256:short pwd",
    });
    // The unkeyed label is not a command hash prefix any more.
    expect(splitAuditPath("command", `sha256:${HASH} pwd`)).toEqual({
      hash: null,
      text: `sha256:${HASH} pwd`,
    });
  });

  it("shows the program but no hash chip for the unavailable sentinel", () => {
    expect(splitAuditPath("command", "hmac-sha256:unavailable pwd")).toEqual({
      hash: null,
      text: "pwd",
    });
  });
});
