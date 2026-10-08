// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { memberFixture, poolFixture } from "./$poolId/-pool-fixture";

const state = vi.hoisted(() => ({
  create: vi.fn(),
  setMode: vi.fn(),
  update: vi.fn(),
  navigate: vi.fn(),
  setModeError: null as unknown,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
    useNavigate: () => state.navigate,
    createFileRoute: () => (options: { component: ComponentType }) => ({
      options,
      useParams: () => ({ lang: "en-US" }),
    }),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${Object.values(options).map(String).join("|")}` : key,
    i18n: { language: "en-US" },
  }),
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@ws-model-proxy/ui/components/responsive-dialog", () => ({
  ResponsiveDialog: ({
    open,
    onOpenChange,
    title,
    children,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: ReactNode;
    children: ReactNode;
  }) =>
    open ? (
      <div role="dialog" aria-label={String(title)}>
        <button type="button" onClick={() => onOpenChange(false)}>
          close
        </button>
        {children}
      </div>
    ) : null,
}));

vi.mock("@/components/page-stub", () => ({ PageHeading: () => <h1>Pools</h1> }));

const mutation = (spy: (input: unknown) => void) => ({
  mutationOptions: () => ({
    mutationFn: async (input: unknown) => {
      spy(input);
      return { id: "pool-new" };
    },
  }),
});

vi.mock("@/utils/orpc", () => ({
  orpc: {
    pools: {
      key: () => ["pools"],
      list: {
        queryOptions: () => ({
          queryKey: ["pools", "list"],
          queryFn: async () => ({
            pools: [
              poolFixture({
                cloud: {
                  mode: "OFF",
                  embeddingContract: null,
                  paidWarmProtection: false,
                  ownKeyEquivalentModel: null,
                },
                members: [
                  memberFixture(),
                  memberFixture({ id: "m-2" }),
                  memberFixture({ id: "m-3", shareId: "s-1", contributorEmail: "bob@x.test" }),
                ],
              }),
            ],
            sharedWithMe: [],
          }),
        }),
      },
      create: mutation((input) => state.create(input)),
      update: mutation((input) => state.update(input)),
      cloud: {
        setMode: mutation((input) => {
          state.setMode(input);
          if (state.setModeError) throw state.setModeError;
        }),
      },
    },
    models: { key: () => ["models"] },
    activity: { overview: { key: () => ["activity", "overview"] } },
    runtimes: {
      key: () => ["runtimes"],
      list: {
        queryOptions: () => ({
          queryKey: ["runtimes", "list"],
          queryFn: async () => ({
            runtimes: [
              { id: "rt-1", name: "qwen box", modelType: "LLM", models: ["Qwen/Qwen3-8B"] },
              { id: "rt-2", name: "bge", modelType: "EMBEDDINGS", models: ["BAAI/bge-m3"] },
            ],
          }),
        }),
      },
    },
    providers: {
      models: {
        list: {
          queryOptions: () => ({
            queryKey: ["providers", "models"],
            queryFn: async () => ({
              models: [
                {
                  id: "pm-1",
                  enabled: true,
                  type: "EMBEDDINGS",
                  displayName: "OpenAI embeddings",
                  upstreamModelId: "openai/text-embedding-3-small",
                },
                {
                  id: "pm-2",
                  enabled: true,
                  type: "LLM",
                  displayName: null,
                  upstreamModelId: "openai/gpt-4o",
                },
              ],
            }),
          }),
        },
      },
    },
  },
}));

import { Route } from "./index";

const Component = Route.options.component as ComponentType & {
  preload?: () => Promise<unknown>;
};

beforeAll(async () => {
  await Component.preload?.();
}, 30_000);

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
  await screen.findByText("Chat");
}

async function openSheet() {
  fireEvent.click(screen.getByRole("button", { name: "dashboard:pool.new" }));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByRole("option", { name: "bge · BAAI/bge-m3" });
  return dialog;
}

afterEach(() => {
  cleanup();
  state.create.mockReset();
  state.setMode.mockReset();
  state.update.mockReset();
  state.navigate.mockReset();
  state.setModeError = null;
});

describe("pools page", () => {
  it("draws each pool's flow: local, contributed, then cloud", async () => {
    await mount();
    const flow = screen.getByRole("list", { name: "dashboard:pool.flow.label" });
    expect(
      within(flow)
        .getAllByRole("listitem")
        .map((step) => step.textContent),
    ).toEqual([
      "dashboard:pool.flow.local:2",
      "dashboard:pool.flow.contributed:1",
      "dashboard:pool.flow.cloudOff:0",
    ]);
  });

  it("creates a local-only pool from a served model, prefilling type, name and slug", async () => {
    await mount();
    const dialog = await openSheet();
    fireEvent.change(within(dialog).getByLabelText("dashboard:pool.newSheet.servedModel"), {
      target: { value: "rt-2::BAAI/bge-m3" },
    });
    expect(
      (within(dialog).getByLabelText("dashboard:pool.form.name") as HTMLInputElement).value,
    ).toBe("bge-m3");
    expect(
      (within(dialog).getByLabelText("dashboard:pool.form.slug") as HTMLInputElement).value,
    ).toBe("bge-m3");
    // The type follows from the model.
    expect(within(dialog).queryByLabelText("dashboard:pool.form.type")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "dashboard:pool.create" }));
    await waitFor(() =>
      expect(state.create).toHaveBeenCalledWith({
        name: "bge-m3",
        slug: "bge-m3",
        type: "EMBEDDINGS",
        members: [{ runtimeId: "rt-2", model: "BAAI/bge-m3" }],
      }),
    );
    expect(state.setMode).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(state.navigate).toHaveBeenCalledWith({
        to: "/$lang/pools/$poolId",
        params: { lang: "en-US", poolId: "pool-new" },
      }),
    );
  });

  it("keeps a name the person typed when the served model changes", async () => {
    await mount();
    const dialog = await openSheet();
    fireEvent.change(within(dialog).getByLabelText("dashboard:pool.form.name"), {
      target: { value: "Mine" },
    });
    fireEvent.change(within(dialog).getByLabelText("dashboard:pool.newSheet.servedModel"), {
      target: { value: "rt-1::Qwen/Qwen3-8B" },
    });
    expect(
      (within(dialog).getByLabelText("dashboard:pool.form.name") as HTMLInputElement).value,
    ).toBe("Mine");
    expect(
      (within(dialog).getByLabelText("dashboard:pool.form.slug") as HTMLInputElement).value,
    ).toBe("mine");
  });

  it("runs the optional cloud step after creating the pool", async () => {
    await mount();
    const dialog = await openSheet();
    fireEvent.change(within(dialog).getByLabelText("dashboard:pool.newSheet.servedModel"), {
      target: { value: "rt-2::BAAI/bge-m3" },
    });
    expect(within(dialog).queryByLabelText("dashboard:pool.cloud.mode")).toBeNull();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "dashboard:pool.newSheet.withCloud" }),
    );
    const model = await within(dialog).findByLabelText("dashboard:pool.newSheet.firstCloudMember");
    // Only enabled provider models of the pool's type.
    await within(dialog).findByRole("option", { name: "OpenAI embeddings" });
    expect(within(dialog).queryByRole("option", { name: "openai/gpt-4o" })).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("dashboard:pool.cloud.mode"), {
      target: { value: "OWNER_AND_SHARES" },
    });
    fireEvent.change(model, { target: { value: "pm-1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "dashboard:pool.create" }));
    await waitFor(() =>
      expect(state.setMode).toHaveBeenCalledWith({ poolId: "pool-new", mode: "OWNER_AND_SHARES" }),
    );
    await waitFor(() =>
      expect(state.update).toHaveBeenCalledWith({
        poolId: "pool-new",
        cloudMembers: [{ providerModelId: "pm-1" }],
      }),
    );
    expect(state.create).toHaveBeenCalledTimes(1);
  });

  it("opens the pool's Cloud tab when the cloud step fails after the pool exists", async () => {
    state.setModeError = new Error("nope");
    await mount();
    const dialog = await openSheet();
    fireEvent.change(within(dialog).getByLabelText("dashboard:pool.newSheet.servedModel"), {
      target: { value: "rt-1::Qwen/Qwen3-8B" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "dashboard:pool.newSheet.withCloud" }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "dashboard:pool.create" }));
    await waitFor(() =>
      expect(state.navigate).toHaveBeenCalledWith({
        to: "/$lang/pools/$poolId/cloud",
        params: { lang: "en-US", poolId: "pool-new" },
      }),
    );
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.update).not.toHaveBeenCalled();
  });

  it("starts over after a cancelled sheet", async () => {
    await mount();
    const dialog = await openSheet();
    fireEvent.change(within(dialog).getByLabelText("dashboard:pool.form.name"), {
      target: { value: "Draft" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    const reopened = await openSheet();
    expect(
      (within(reopened).getByLabelText("dashboard:pool.form.name") as HTMLInputElement).value,
    ).toBe("");
  });
});
