// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  saves: [] as Array<Record<string, unknown>>,
  applyCalls: [] as Array<Record<string, unknown>>,
}));
const { NODE_A, NODE_B, START } = vi.hoisted(() => {
  const NODE_A = { id: "node-a", slug: "spark-1", name: null };
  const NODE_B = { id: "node-b", slug: "spark-2", name: null };
  const START = {
    runtimeId: "rt-1",
    versionId: "v-1",
    instanceId: null,
    placements: [{ nodeId: "node-b", nodeSlug: "spark-2", port: 30001 }],
    fabric: null,
    distPort: null,
  };
  return { NODE_A, NODE_B, START };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}(${JSON.stringify(options)})` : key,
  }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => async () => undefined }));
vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/components/confirm-delete-dialog", () => ({ ConfirmDeleteDialog: () => null }));
vi.mock("@/components/help", () => ({ Help: ({ children }: { children: ReactNode }) => children }));

vi.mock("@/utils/orpc", () => {
  // Lists render from the first paint (initialData), so no test waits on a
  // wall-clock deadline for a query to settle.
  const list = (key: string, data: unknown) => ({
    queryOptions: (options?: { input?: unknown }) => ({
      queryKey: [key, options?.input ?? null],
      queryFn: async () => data,
      initialData: data,
    }),
  });
  return {
    orpc: {
      profiles: {
        key: () => ["profiles"],
        save: {
          mutationOptions: (options?: Record<string, unknown>) => ({
            ...options,
            mutationFn: async (input: Record<string, unknown>) => {
              state.saves.push(input);
              return {};
            },
          }),
        },
        delete: { mutationOptions: (options?: object) => ({ ...options, mutationFn: vi.fn() }) },
        apply: {
          call: async (input: Record<string, unknown>) => {
            state.applyCalls.push(input);
            return {
              mode: "preview",
              preview: {
                fingerprint: "f".repeat(64),
                starts: [START],
                stops: [],
                kept: [],
                holds: [],
                warnings: [],
                refusals: [],
              },
            };
          },
          mutationOptions: (options?: object) => ({ ...options, mutationFn: vi.fn() }),
        },
      },
      nodes: { key: () => ["nodes"], list: list("nodes", { nodes: [NODE_A, NODE_B] }) },
      runtimes: {
        list: list("runtimes", {
          runtimes: [
            {
              id: "rt-1",
              name: "Qwen vLLM",
              kind: "STARTABLE",
              currentVersion: { id: "v-3", version: 3 },
            },
          ],
        }),
        versions: {
          list: list("versions", {
            items: [
              { id: "v-3", version: 3 },
              { id: "v-2", version: 2 },
              { id: "v-1", version: 1 },
            ],
            nextCursor: null,
          }),
        },
      },
    },
  };
});

import type { NodeSummary, ProfileView } from "@/components/nodes/node-types";
import { ApplyProfileDialog } from "./apply-profile-dialog";
import { ProfileEditor } from "./profile-editor";

const PROFILE = {
  id: "p-1",
  slug: "evening",
  name: "Evening",
  description: null,
  editor: { actor: "USER", userId: "u-1", agentTokenId: null, label: "Ada" },
  updatedAt: "2026-10-06T10:00:00.000Z",
  nodeIds: ["node-a", "node-b"],
  holds: [],
  items: [
    {
      id: "item-1",
      position: 0,
      runtimeId: "rt-1",
      runtimeSlug: "qwen",
      versionId: "v-2",
      versionNumber: 2,
      pinOutdated: true,
      count: 1,
      nodeIds: [],
      runningNow: 0,
    },
  ],
  satisfied: false,
  lastApply: null,
} satisfies ProfileView;

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

const nodes = [NODE_A, NODE_B] as unknown as NodeSummary[];

afterEach(() => {
  cleanup();
  state.saves = [];
  state.applyCalls = [];
});

describe("profile items", () => {
  it("picks an older pinned version and the line's own nodes", async () => {
    wrap(<ProfileEditor profile={PROFILE} nodes={nodes} lang="en-US" />);
    const version = screen.getByLabelText("dashboard:profiles.editor.version") as HTMLSelectElement;
    within(version).getByRole("option", {
      name: 'dashboard:profiles.editor.versionCurrent({"version":3})',
    });
    expect(version.value).toBe("v-2");
    fireEvent.change(version, { target: { value: "v-1" } });
    const itemNodes = screen.getByRole("group", { name: "dashboard:profiles.editor.itemNodes" });
    expect(within(itemNodes).getByText("dashboard:profiles.editor.itemNodesAny")).toBeTruthy();
    fireEvent.click(within(itemNodes).getAllByRole("checkbox")[1] as HTMLElement);
    expect(within(itemNodes).getByText("dashboard:profiles.editor.itemNodesSome")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));
    await waitFor(() => expect(state.saves).toHaveLength(1));
    expect(state.saves[0]?.items).toEqual([
      { runtimeId: "rt-1", versionId: "v-1", count: 1, nodeIds: ["node-b"] },
    ]);
    expect(state.saves[0]).not.toHaveProperty("updatePins");
  });

  it("Update pins moves every line to the current version (no explicit versions)", async () => {
    wrap(<ProfileEditor profile={PROFILE} nodes={nodes} lang="en-US" />);
    fireEvent.click(screen.getByRole("button", { name: "dashboard:profiles.editor.updatePins" }));
    await waitFor(() => expect(state.saves).toHaveLength(1));
    expect(state.saves[0]).toMatchObject({ updatePins: true });
    expect(state.saves[0]?.items).toEqual([{ runtimeId: "rt-1", count: 1, nodeIds: [] }]);
  });
});

describe("profile item rows", () => {
  const twoLines = {
    ...PROFILE,
    items: [
      { ...PROFILE.items[0], id: "item-1", position: 0, versionId: "v-1", versionNumber: 1 },
      {
        ...PROFILE.items[0],
        id: "item-2",
        position: 1,
        versionId: "v-3",
        versionNumber: 3,
        pinOutdated: false,
      },
    ],
  } as ProfileView;

  it("keeps each saved line's pin on its own row after a row above is removed", async () => {
    wrap(<ProfileEditor profile={twoLines} nodes={nodes} lang="en-US" />);
    expect(screen.getByText(/profiles\.editor\.pinned\(\{"version":1\}\)/)).toBeTruthy();
    fireEvent.click(
      screen.getAllByRole("button", {
        name: "dashboard:profiles.editor.removeItem",
      })[0] as HTMLElement,
    );
    expect(screen.queryByText(/profiles\.editor\.pinned\(\{"version":1\}\)/)).toBeNull();
    expect(screen.getByText(/profiles\.editor\.pinned\(\{"version":3\}\)/)).toBeTruthy();
    expect(
      (screen.getByLabelText("dashboard:profiles.editor.version") as HTMLSelectElement).value,
    ).toBe("v-3");
  });

  it("waits for a save before Update pins moves every line", async () => {
    wrap(<ProfileEditor profile={PROFILE} nodes={nodes} lang="en-US" />);
    const updatePins = screen.getByRole("button", {
      name: "dashboard:profiles.editor.updatePins",
    }) as HTMLButtonElement;
    expect(updatePins.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("dashboard:profiles.editor.version"), {
      target: { value: "v-1" },
    });
    await waitFor(() => expect(updatePins.disabled).toBe(true));
  });

  it("saves a new line's Current version as the runtime's current version id", async () => {
    wrap(<ProfileEditor profile={{ ...PROFILE, items: [] }} nodes={nodes} lang="en-US" />);
    const add = screen.getByRole("button", { name: "dashboard:profiles.editor.addItem" });
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(add);
    const save = screen.getByRole("button", { name: "common:actions.save" }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(state.saves).toHaveLength(1));
    expect(state.saves[0]?.items).toEqual([
      { runtimeId: "rt-1", versionId: "v-3", count: 1, nodeIds: [] },
    ]);
  });
});

describe("apply preview", () => {
  it("shows the pinned version each start runs", async () => {
    const profile = {
      ...PROFILE,
      items: [{ ...PROFILE.items[0], versionId: "v-1", versionNumber: 1, nodeIds: ["node-b"] }],
    } as ProfileView;
    wrap(<ApplyProfileDialog profile={profile} open onOpenChange={() => undefined} />);
    expect(
      await screen.findByText(/dashboard:profiles\.apply\.startVersion\(\{"version":1\}\)/),
    ).toBeTruthy();
    expect(screen.getByText(/spark-2:30001/)).toBeTruthy();
    expect(state.applyCalls).toEqual([{ profileId: "p-1", preview: true }]);
  });
});
