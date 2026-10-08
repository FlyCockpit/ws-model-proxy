// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Access → Contributing: pick a pool shared with you, then one of your served models, then Add;
 * withdraw what you contribute; fork a runtime definition shared with you onto your node.
 */

const state = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; input: unknown }>,
  navigations: [] as unknown[],
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (options: { component: ComponentType }) => ({
      options,
      useParams: () => ({ lang: "en-US" }),
    }),
    Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
    useNavigate: () => async (to: unknown) => {
      state.navigations.push(to);
    },
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && typeof opts.name === "string" ? `${key}:${opts.name}` : key,
    i18n: { language: "en-US" },
  }),
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("@ws-model-proxy/ui/components/responsive-dialog", () => ({
  ResponsiveDialog: ({
    open,
    title,
    children,
  }: {
    open: boolean;
    title: string;
    children: ReactNode;
  }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        {children}
      </div>
    ) : null,
}));

// A plain confirm: the real one is a Radix alert dialog.
vi.mock("@/components/access/confirm-action", () => ({
  ConfirmAction: ({
    open,
    title,
    confirmLabel,
    onConfirm,
  }: {
    open: boolean;
    title: string;
    confirmLabel: string;
    onConfirm: () => void;
  }) =>
    open ? (
      <div role="alertdialog" aria-label={title}>
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

vi.mock("@/utils/orpc", () => {
  const query = (path: string[], data: () => unknown) => ({
    key: () => path,
    queryOptions: () => ({ queryKey: path, queryFn: async () => data() }),
  });
  const mutation = (name: string, answer: () => unknown) => ({
    mutationOptions: (options?: Record<string, unknown>) => ({
      ...options,
      mutationFn: async (input: unknown) => {
        state.calls.push({ name, input });
        return answer();
      },
    }),
  });
  return {
    orpc: {
      access: {
        contributing: {
          key: () => ["access", "contributing"],
          pools: query(["access", "contributing", "pools"], () => ({
            pools: [
              {
                shareId: "sh-1",
                poolId: "pool-chat",
                callableId: "alice/chat",
                ownerEmail: "alice@example.test",
                modelType: "LLM",
                ownHardwareOnly: false,
                yourMembers: [
                  { memberId: "mem-1", runtimeModelId: "rm-old", upstreamModelId: "llama" },
                ],
              },
              {
                shareId: "sh-2",
                poolId: "pool-embed",
                callableId: "alice/embed",
                ownerEmail: "alice@example.test",
                modelType: "EMBEDDINGS",
                ownHardwareOnly: false,
                yourMembers: [],
              },
            ],
            servedModels: [
              {
                runtimeModelId: "rm-old",
                upstreamModelId: "llama",
                type: "LLM",
                runtimeId: "rt-1",
                runtimeName: "Box",
              },
              {
                runtimeModelId: "rm-qwen",
                upstreamModelId: "qwen",
                type: "LLM",
                runtimeId: "rt-1",
                runtimeName: "Box",
              },
              {
                runtimeModelId: "rm-bge",
                upstreamModelId: "bge",
                type: "EMBEDDINGS",
                runtimeId: "rt-2",
                runtimeName: "Embedder",
              },
            ],
          })),
        },
      },
      pools: {
        key: () => ["pools"],
        members: {
          addContributed: mutation("pools.members.addContributed", () => ({})),
          removeContributed: mutation("pools.members.removeContributed", () => ({ ok: true })),
        },
      },
      nodes: {
        list: query(["nodes", "list"], () => ({
          nodes: [{ id: "node-1", name: "Basement GPU", slug: "basement" }],
        })),
      },
      runtimes: {
        key: () => ["runtimes"],
        fork: mutation("runtimes.fork", () => ({ runtime: { id: "rt-new" } })),
        shares: {
          list: query(["runtimes", "shares", "list"], () => ({
            sharedByMe: [],
            sharedWithMe: [
              {
                id: "rs-1",
                runtimeId: "rt-theirs",
                ownerEmail: "bob@example.test",
                name: "Bob Qwen",
                kind: "ALWAYS_ON",
                currentVersion: { version: 3 },
              },
              {
                id: "rs-2",
                runtimeId: "rt-startable",
                ownerEmail: "bob@example.test",
                name: "Bob Whisper",
                kind: "STARTABLE",
                currentVersion: { version: 1 },
              },
            ],
          })),
        },
      },
    },
  };
});

import { Route } from "./contributions";

async function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Component = Route.options.component as ComponentType & {
    preload?: () => Promise<unknown>;
  };
  await Component.preload?.();
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
  await screen.findByText("access:contributions.addTitle");
}

function optionLabels(select: HTMLElement) {
  return within(select)
    .getAllByRole("option")
    .map((option) => option.textContent);
}

afterEach(() => {
  cleanup();
  state.calls = [];
  state.navigations = [];
});

describe("Access → Contributing", { timeout: 30_000 }, () => {
  it("adds a served model of the pool's type that is not in the pool yet", async () => {
    await mount();
    const pool = screen.getByLabelText("access:contributions.pool");
    fireEvent.change(pool, { target: { value: "pool-chat" } });
    const model = screen.getByLabelText("access:contributions.model");
    // Only LLM models, without the one already contributed.
    expect(optionLabels(model)).toEqual(["access:contributions.pickModel", "qwen · Box"]);
    fireEvent.change(model, { target: { value: "rm-qwen" } });
    fireEvent.click(screen.getByRole("button", { name: "access:contributions.add" }));
    await waitFor(() =>
      expect(state.calls).toEqual([
        {
          name: "pools.members.addContributed",
          input: { poolId: "pool-chat", runtimeModelId: "rm-qwen" },
        },
      ]),
    );
  });

  it("asks for a pool and a model before adding", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "access:contributions.add" }));
    expect(await screen.findByText("access:contributions.choosePool")).toBeTruthy();
    expect(state.calls).toEqual([]);
  });

  it("withdraws a contributed model after confirming", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "access:contributions.withdraw" }));
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "access:contributions.withdraw" }));
    await waitFor(() =>
      expect(state.calls).toEqual([
        { name: "pools.members.removeContributed", input: { memberId: "mem-1" } },
      ]),
    );
  });

  it("forks a shared always-on definition onto a chosen node under a new name", async () => {
    await mount();
    expect(await screen.findByText("Bob Qwen")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "access:fork.action" }));
    const dialog = await screen.findByRole("dialog", { name: "access:fork.title:Bob Qwen" });
    const node = await within(dialog).findByLabelText("dashboard:runtime.form.node");
    // A node is required for an always-on fork.
    fireEvent.click(within(dialog).getByRole("button", { name: "access:fork.submit" }));
    expect(await within(dialog).findByText("access:fork.nodeRequired")).toBeTruthy();
    fireEvent.change(node, { target: { value: "node-1" } });
    fireEvent.change(within(dialog).getByLabelText("dashboard:runtime.form.name"), {
      target: { value: "My Qwen" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "access:fork.submit" }));
    await waitFor(() =>
      expect(state.calls).toEqual([
        {
          name: "runtimes.fork",
          input: { runtimeId: "rt-theirs", name: "My Qwen", slug: "my-qwen", nodeId: "node-1" },
        },
      ]),
    );
    await waitFor(() =>
      expect(state.navigations).toEqual([
        { to: "/$lang/runtimes/$runtimeId", params: { lang: "en-US", runtimeId: "rt-new" } },
      ]),
    );
  });
});

describe("Access → Contributing: fork a startable definition", { timeout: 30_000 }, () => {
  it("asks for no node and forks under the shared name", async () => {
    await mount();
    expect(await screen.findByText("Bob Whisper")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "access:fork.actionStartable" }));
    const dialog = await screen.findByRole("dialog", { name: "access:fork.title:Bob Whisper" });
    expect(within(dialog).queryByLabelText("dashboard:runtime.form.node")).toBeNull();
    expect(within(dialog).getByText("access:fork.startableHint")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "access:fork.submit" }));
    await waitFor(() =>
      expect(state.calls).toEqual([
        {
          name: "runtimes.fork",
          input: { runtimeId: "rt-startable", name: "Bob Whisper", slug: "bob-whisper" },
        },
      ]),
    );
  });
});
