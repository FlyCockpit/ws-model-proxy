// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; input: unknown }>,
  data: {} as Record<string, unknown>,
  errors: {} as Record<string, unknown>,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en-US" } }),
}));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({ state: { session: { user: { id: "owner" } } } }),
}));
vi.mock("@/utils/orpc", () => {
  const query = (name: string) => ({
    queryOptions: (options?: { input?: unknown; enabled?: boolean }) => ({
      queryKey: [name, options?.input],
      queryFn: async () => state.data[name],
      enabled: options?.enabled,
    }),
  });
  const mutation = (name: string) => ({
    mutationOptions: (options?: Record<string, unknown>) => ({
      mutationFn: async (input: unknown) => {
        state.calls.push({ name, input });
        if (state.errors[name]) throw state.errors[name];
        return state.data[name] ?? { id: "saved", revision: 2 };
      },
      ...options,
    }),
  });
  return {
    orpc: {
      deployments: {
        key: () => ["deployments"],
        listConfigs: query("configs"),
        listInstances: query("instances"),
        pendingPlans: query("pending"),
        getConfig: query("config"),
        planStatus: query("plan"),
        createConfig: mutation("create"),
        updateConfig: mutation("update"),
        deleteConfig: mutation("deleteConfig"),
        planStart: mutation("start"),
        planStop: mutation("stop"),
        confirmPlan: mutation("confirm"),
        setNodeGrant: mutation("grant"),
        setAgentsMayPreempt: mutation("preempt"),
      },
      forwarderManagement: {
        key: () => ["forwarder"],
        listCliDevices: query("devices"),
        listModelPools: query("pools"),
        updateModelPool: mutation("policy"),
      },
      inferenceContributions: {
        key: () => ["contributions"],
        list: query("offers"),
        offer: mutation("offer"),
        accept: mutation("accept"),
        revoke: mutation("revoke"),
      },
    },
  };
});

import { DeploymentsPage, recipeJsonSchema } from "./deployments-page";
import { PoolExecutionPolicy } from "./pool-execution-policy";

const variant = {
  key: "small",
  engine: "other",
  groupSize: 1,
  resources: [{ kind: "cpu", ramGb: 4 }],
  commands: [{ management: "ownedProcess", start: "serve-model", stop: "stop-model" }],
  readiness: { path: "/health" },
  models: ["model"],
  attachment: { type: "llm", poolId: "pool" },
  hardConcurrencyLimit: 1,
};
function show(component = <DeploymentsPage />) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      {component}
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  state.calls.length = 0;
  state.errors = {};
  state.data = {
    configs: { items: [], nextCursor: null },
    instances: { items: [], nextCursor: null },
    pending: { items: [], nextCursor: null },
    devices: [],
    pools: [{ id: "pool", name: "Pool" }],
    offers: [],
  };
});
afterEach(cleanup);

describe("managed inference dashboard", () => {
  it("renders the empty state and creates a schema-validated immutable recipe", async () => {
    const user = userEvent.setup();
    show();
    await user.type(await screen.findByLabelText("deployments.name"), "Small");
    await user.type(screen.getByLabelText("deployments.slug"), "small");
    await user.selectOptions(screen.getByLabelText("deployments.pool"), "pool");
    const spec = screen.getByLabelText("deployments.spec");
    await user.clear(spec);
    await user.click(spec);
    await user.paste(JSON.stringify({ variants: [variant] }));
    expect(recipeJsonSchema.safeParse((spec as HTMLTextAreaElement).value).success).toBe(true);
    expect((screen.getByLabelText("deployments.pool") as HTMLSelectElement).value).toBe("pool");
    await user.click(screen.getByRole("button", { name: "deployments.saveRecipe" }));
    await waitFor(() => expect(state.calls.some((call) => call.name === "create")).toBe(true));
    expect(state.calls.find((call) => call.name === "create")?.input).toMatchObject({
      slug: "small",
      poolId: "pool",
      spec: { variants: [{ groupSize: 1 }] },
    });
  });

  it("rebinds a recipe whose pool was deleted and deletes a recipe only after typing its slug", async () => {
    const user = userEvent.setup();
    const detached = {
      id: "recipe",
      name: "Small",
      slug: "small",
      poolId: null,
      Revisions: [{ id: "revision", revision: 1, spec: { variants: [variant] } }],
    };
    state.data.configs = { items: [detached], nextCursor: null };
    state.data.config = detached;
    state.data.pools = [{ id: "next", name: "Next" }];
    show();
    await user.click(
      await screen.findByRole("button", { name: /Small · 1 · deployments.detachedLabel/ }),
    );
    expect(await screen.findByText("deployments.recipeDetached")).toBeTruthy();
    // Choosing the pool points every variant's attachment at it.
    await user.selectOptions(screen.getByLabelText("deployments.pool"), "next");
    expect(
      JSON.parse((screen.getByLabelText("deployments.spec") as HTMLTextAreaElement).value),
    ).toMatchObject({ variants: [{ attachment: { type: "llm", poolId: "next" } }] });
    await user.click(screen.getByRole("button", { name: "deployments.saveRecipe" }));
    await waitFor(() => expect(state.calls.some((call) => call.name === "update")).toBe(true));
    expect(state.calls.find((call) => call.name === "update")?.input).toMatchObject({
      id: "recipe",
      expectedRevision: 1,
      poolId: "next",
      spec: { variants: [{ attachment: { poolId: "next" } }] },
    });

    await user.click(screen.getByRole("button", { name: "deployments.deleteRecipe" }));
    const confirm = await screen.findByRole("alertdialog");
    const action = within(confirm)
      .getAllByRole("button")
      .find((button) => button.textContent === "actions.delete");
    expect(action?.hasAttribute("disabled")).toBe(true);
    expect(state.calls.some((call) => call.name === "deleteConfig")).toBe(false);
    await user.type(within(confirm).getByLabelText("deployments.deleteRecipePrompt"), "small");
    await user.click(action!);
    await waitFor(() =>
      expect(state.calls.find((call) => call.name === "deleteConfig")?.input).toEqual({
        id: "recipe",
      }),
    );
  });

  it("renames a recipe whose slug predates the slug rule, and explains a refused rename", async () => {
    const user = userEvent.setup();
    const legacy = {
      id: "recipe",
      name: "Small",
      slug: "small-",
      poolId: "pool",
      Revisions: [{ id: "revision", revision: 1, spec: { variants: [variant] } }],
    };
    state.data.configs = { items: [legacy], nextCursor: null };
    state.data.config = legacy;
    show();
    await user.click(await screen.findByRole("button", { name: /Small · 1/ }));
    const slug = (await screen.findByLabelText("deployments.slug")) as HTMLInputElement;
    expect(slug.disabled).toBe(false);
    expect(screen.getByText("deployments.slugHint")).toBeTruthy();
    // The unchanged legacy slug still saves other edits, without a rename.
    await user.click(screen.getByRole("button", { name: "deployments.saveRecipe" }));
    await waitFor(() => expect(state.calls.some((call) => call.name === "update")).toBe(true));
    expect(state.calls.find((call) => call.name === "update")?.input).not.toHaveProperty("slug");
    // A new slug must be valid.
    state.calls.length = 0;
    await user.clear(slug);
    await user.type(slug, "sm--all");
    await user.click(screen.getByRole("button", { name: "deployments.saveRecipe" }));
    expect(await screen.findByText("deployments.invalid")).toBeTruthy();
    expect(state.calls.some((call) => call.name === "update")).toBe(false);
    // A running recipe cannot be renamed; the refusal says what to do.
    state.errors.update = Object.assign(new Error("conflict"), {
      code: "CONFLICT",
      status: 409,
      data: { reason: "deployments_running" },
    });
    await user.clear(slug);
    await user.type(slug, "small");
    await user.click(screen.getByRole("button", { name: "deployments.saveRecipe" }));
    expect(await screen.findByText("deployments.stopBeforeChange")).toBeTruthy();
    expect(state.calls.find((call) => call.name === "update")?.input).toMatchObject({
      slug: "small",
    });
  });

  it("human confirmation displays the immutable stop commands and cannot apply without explicit review", async () => {
    state.data.pending = { items: [{ id: "plan-1" }], nextCursor: null };
    state.data.plan = {
      id: "plan-1",
      state: "AWAITING_CONFIRMATION",
      contents: { action: "stop", stopIds: ["group-1"], affectedNodeIds: ["node-a", "node-b"] },
      preview: {
        start: null,
        stopped: [
          {
            id: "group-1",
            endpointSlug: "group",
            nodes: [{ rank: 0 }, { rank: 1 }],
            variant: { commands: [{ stop: "stop-rank-zero" }, { stop: "stop-rank-one" }] },
          },
        ],
      },
    };
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("button", { name: /deployments.reviewPlan.*plan-1/ }));
    expect(await screen.findByText(/node-a, node-b/)).toBeTruthy();
    expect(screen.getByText(/stop-rank-one/)).toBeTruthy();
    const confirm = screen.getByRole("button", { name: "deployments.confirm" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByLabelText("deployments.confirmHint"));
    await user.click(confirm);
    await waitFor(() =>
      expect(state.calls).toContainEqual({ name: "confirm", input: { planId: "plan-1" } }),
    );
  });

  it("shows hidden characters as escapes and flags a revision an agent edited", async () => {
    state.data.pending = { items: [{ id: "plan-2" }], nextCursor: null };
    state.data.plan = {
      id: "plan-2",
      state: "AWAITING_CONFIRMATION",
      contents: {
        action: "start",
        stopIds: [],
        affectedNodeIds: ["node-a"],
        start: { revisionId: "rev", variantKey: "one" },
      },
      preview: {
        start: { commands: [{ start: "serve #\u202e;rm -rf ~\u2069" }] },
        agentEdited: true,
        stopped: [],
      },
    };
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("button", { name: /deployments.reviewPlan.*plan-2/ }));
    expect(await screen.findByText("deployments.agentEditedRevision")).toBeTruthy();
    const commands = screen.getByText(/serve #/);
    expect(commands.textContent).toContain("\\u{202e}");
    expect(commands.textContent).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
  });

  it("asks in an alert dialog before a start stops running deployments, naming each one", async () => {
    state.data.pending = { items: [{ id: "plan-3" }], nextCursor: null };
    state.data.plan = {
      id: "plan-3",
      state: "AWAITING_CONFIRMATION",
      contents: {
        action: "start",
        stopIds: ["running-1"],
        affectedNodeIds: ["node-a", "node-b"],
        start: { revisionId: "rev", variantKey: "one" },
      },
      preview: {
        start: { commands: [{ start: "serve-new", stop: "stop-new" }] },
        agentEdited: false,
        stopped: [
          {
            id: "running-1",
            endpointSlug: "inst-old-model",
            nodes: [{ rank: 0 }, { rank: 1 }],
            variant: { commands: [{ stop: "stop-old" }] },
          },
        ],
      },
    };
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("button", { name: /deployments.reviewPlan.*plan-3/ }));
    await user.click(await screen.findByLabelText("deployments.confirmHint"));
    await user.click(screen.getByRole("button", { name: "deployments.confirm" }));
    // The plan is not applied until the person confirms the stop.
    expect(state.calls.some((call) => call.name === "confirm")).toBe(false);
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("inst-old-model")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "deployments.preemptConfirm" }));
    await waitFor(() =>
      expect(state.calls).toContainEqual({ name: "confirm", input: { planId: "plan-3" } }),
    );
  });

  it("leaves a stopping start unapplied when the dialog is cancelled, and lists every stopped deployment", async () => {
    state.data.pending = { items: [{ id: "plan-4" }], nextCursor: null };
    state.data.plan = {
      id: "plan-4",
      state: "AWAITING_CONFIRMATION",
      contents: {
        action: "start",
        stopIds: ["old-1", "old-2"],
        affectedNodeIds: ["node-a"],
        start: { revisionId: "rev", variantKey: "one" },
      },
      preview: {
        start: { commands: [{ start: "serve-new", stop: "stop-new" }] },
        agentEdited: false,
        stopped: [
          {
            id: "old-1",
            endpointSlug: "inst-first",
            nodes: [{ rank: 0 }],
            variant: { commands: [] },
          },
          {
            id: "old-2",
            endpointSlug: "inst-second",
            nodes: [{ rank: 0 }],
            variant: { commands: [] },
          },
        ],
      },
    };
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("button", { name: /deployments.reviewPlan.*plan-4/ }));
    await user.click(await screen.findByLabelText("deployments.confirmHint"));
    await user.click(screen.getByRole("button", { name: "deployments.confirm" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("inst-first")).toBeTruthy();
    expect(within(dialog).getByText("inst-second")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "deployments.preemptCancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(state.calls.some((call) => call.name === "confirm")).toBe(false);
  });

  it("confirms a start that stops nothing without the stop dialog", async () => {
    state.data.pending = { items: [{ id: "plan-5" }], nextCursor: null };
    state.data.plan = {
      id: "plan-5",
      state: "AWAITING_CONFIRMATION",
      contents: {
        action: "start",
        stopIds: [],
        affectedNodeIds: ["node-a"],
        start: { revisionId: "rev", variantKey: "one" },
      },
      preview: {
        start: { commands: [{ start: "serve", stop: "stop" }] },
        agentEdited: true,
        stopped: [],
      },
    };
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("button", { name: /deployments.reviewPlan.*plan-5/ }));
    await user.click(await screen.findByLabelText("deployments.confirmHint"));
    await user.click(screen.getByRole("button", { name: "deployments.confirm" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() =>
      expect(state.calls).toContainEqual({ name: "confirm", input: { planId: "plan-5" } }),
    );
  });

  it("defaults paid-cache consent off and validates embedding identity before saving", async () => {
    const user = userEvent.setup();
    show(<PoolExecutionPolicy pool={{ id: "pool" }} />);
    expect((screen.getByLabelText("deployments.paidProtection") as HTMLInputElement).checked).toBe(
      false,
    );
    await user.click(screen.getByLabelText("deployments.embeddingEnable"));
    await user.click(screen.getByRole("button", { name: "deployments.savePolicy" }));
    expect(state.calls).toEqual([]);
    for (const [label, value] of [
      ["model", "embedding-model"],
      ["revisionName", "revision-1"],
      ["dimensions", "128"],
      ["vectorSpace", "space-1"],
    ])
      await user.type(screen.getByLabelText(`deployments.${label}`), value);
    await user.click(screen.getByRole("button", { name: "deployments.savePolicy" }));
    await waitFor(() =>
      expect(state.calls).toContainEqual({
        name: "policy",
        input: {
          id: "pool",
          paidWarmProtectionEnabled: false,
          embeddingContract: {
            model: "embedding-model",
            revision: "revision-1",
            dimensions: 128,
            normalization: "none",
            vectorSpace: "space-1",
          },
        },
      }),
    );
  });

  it("cannot confirm a stop group whose immutable command variant is unavailable", async () => {
    state.data.pending = { items: [{ id: "incomplete" }], nextCursor: null };
    state.data.plan = {
      id: "incomplete",
      state: "AWAITING_CONFIRMATION",
      contents: { action: "stop", stopIds: ["group"], affectedNodeIds: ["node"] },
      preview: {
        start: null,
        stopped: [{ id: "group", endpointSlug: "group", nodes: [], variant: null }],
      },
    };
    const user = userEvent.setup();
    show();
    await user.click(
      await screen.findByRole("button", { name: /deployments.reviewPlan.*incomplete/ }),
    );
    await user.click(screen.getByLabelText("deployments.confirmHint"));
    expect(
      (screen.getByRole("button", { name: "deployments.confirm" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(state.calls.some((call) => call.name === "confirm")).toBe(false);
  });

  it("does not let a delayed stop preview replace a newer selected human plan", async () => {
    let finishStop: (plan: { id: string }) => void = () => {};
    state.data.stop = new Promise<{ id: string }>((resolve) => {
      finishStop = resolve;
    });
    state.data.instances = {
      items: [
        {
          id: "instance",
          endpointSlug: "group",
          observedState: "SERVING",
          desiredState: "SERVING",
          Nodes: [],
          agentsMayPreempt: false,
        },
      ],
      nextCursor: null,
    };
    state.data.pending = { items: [{ id: "newer" }], nextCursor: null };
    state.data.plan = {
      id: "newer",
      state: "AWAITING_CONFIRMATION",
      contents: { action: "stop", stopIds: [], affectedNodeIds: ["newer-node"] },
      preview: { start: null, stopped: [] },
    };
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("button", { name: "deployments.planStop" }));
    await user.click(screen.getByRole("button", { name: /deployments.reviewPlan.*newer/ }));
    expect(await screen.findByText(/newer-node/, { selector: "p" })).toBeTruthy();
    finishStop({ id: "stale" });
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "deployments.planStop" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    await user.click(screen.getByLabelText("deployments.confirmHint"));
    await user.click(screen.getByRole("button", { name: "deployments.confirm" }));
    await waitFor(() =>
      expect(state.calls).toContainEqual({ name: "confirm", input: { planId: "newer" } }),
    );
  });
});
