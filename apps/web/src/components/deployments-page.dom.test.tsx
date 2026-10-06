// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; input: unknown }>,
  data: {} as Record<string, unknown>,
  errors: {} as Record<string, unknown>,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en-US" } }),
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ lang: "en-US" }),
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a href="/en-US/dashboard/terminals" className={className}>
      {children}
    </a>
  ),
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
        return state.data[name] ?? { id: "saved", revision: 2, interactiveWarnings: [] };
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
        reopenOperatorStep: mutation("reopen"),
        restartInstance: mutation("restart"),
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

  it("explains that an interactive recipe needs nodes that can open operator terminals", async () => {
    const recipe = {
      id: "recipe",
      name: "Small",
      slug: "small",
      poolId: "pool",
      Revisions: [{ id: "revision", revision: 1, spec: { variants: [variant] } }],
    };
    state.data.configs = { items: [recipe], nextCursor: null };
    state.errors.start = Object.assign(new Error("These nodes cannot open operator terminals"), {
      code: "PRECONDITION_FAILED",
      status: 412,
      data: { reason: "deployment_operator_unavailable", nodeIds: ["node"] },
    });
    const user = userEvent.setup();
    show();
    const form = (await screen.findByRole("heading", { name: "deployments.planStart" }))
      .parentElement as HTMLElement;
    await user.selectOptions(
      await within(form).findByLabelText("deployments.revision"),
      "revision",
    );
    await user.type(within(form).getByLabelText("deployments.variantKey"), "small");
    await user.click(within(form).getByRole("button", { name: "deployments.preview" }));
    expect(await within(form).findByText("deployments.operatorUnavailable")).toBeTruthy();
    expect(state.calls).toContainEqual({
      name: "start",
      input: { revisionId: "revision", variantKey: "small", groupCount: 1 },
    });
  });

  it("shows what a deployment waits on and offers the person's actions", async () => {
    const step = (overrides: Record<string, unknown>) => ({
      stepId: "step",
      nodeId: "node-a",
      rank: 0,
      action: "start",
      command: "sudo systemctl start model\u202e",
      state: "AWAITING_OPERATOR",
      heldResourceCheck: false,
      since: null,
      acceptedAt: null,
      overdue: false,
      terminalOpen: false,
      lastExit: null,
      errorCode: null,
      ...overrides,
    });
    state.data.instances = {
      items: [
        {
          id: "waiting",
          endpointSlug: "group-a",
          observedState: "STARTING",
          desiredState: "RUNNING",
          agentsMayPreempt: false,
          needsOperator: "STEP",
          Nodes: [],
          operatorSteps: [
            step({ stepId: "closed", lastExit: 3, errorCode: "operator_unverified" }),
            step({ stepId: "open", terminalOpen: true }),
            step({ stepId: "late", state: "RUNNING", overdue: true, terminalOpen: true }),
            step({ stepId: "held", state: "PENDING", errorCode: "operator_capability_missing" }),
          ],
        },
        {
          id: "stopped",
          endpointSlug: "group-b",
          observedState: "STOPPED",
          desiredState: "RUNNING",
          agentsMayPreempt: false,
          needsOperator: "RESTART",
          Nodes: [
            {
              id: "n1",
              rank: 0,
              cliDeviceId: "node-b",
              port: 30000,
              claimHeld: false,
              heldUnknownSince: "2026-10-05T00:00:00.000Z",
              resources: {},
            },
          ],
          operatorSteps: [],
        },
      ],
      nextCursor: null,
    };
    const user = userEvent.setup();
    show();
    expect(await screen.findByText("deploymentOperator.needStep")).toBeTruthy();
    expect(screen.getByText("deploymentOperator.needRestart")).toBeTruthy();
    // Commands are escaped exactly as the node's confirm screen shows them.
    expect(screen.getAllByText("sudo systemctl start model\\u{202e}").length).toBe(4);
    expect(screen.getByText("deploymentOperator.reasons.unverified")).toBeTruthy();
    expect(screen.getByText("deploymentOperator.reasons.capabilityMissing")).toBeTruthy();
    expect(screen.getByText("deploymentOperator.status.overdue")).toBeTruthy();
    expect(screen.getByText("deploymentOperator.lastExit")).toBeTruthy();
    expect(screen.getAllByText("deploymentOperator.openTerminal")).toHaveLength(2);
    expect(screen.getByText("deploymentOperator.heldTitle")).toBeTruthy();
    // Only the closed waiting step can be reopened.
    const reopen = screen.getAllByRole("button", { name: "deploymentOperator.reopen" });
    expect(reopen).toHaveLength(1);
    await user.click(reopen[0] as HTMLElement);
    await user.click(screen.getByRole("button", { name: "deploymentOperator.restart" }));
    await waitFor(() =>
      expect(state.calls).toEqual(
        expect.arrayContaining([
          { name: "reopen", input: { stepId: "closed" } },
          { name: "restart", input: { instanceId: "stopped" } },
        ]),
      ),
    );
  });

  it("says who wrote a waiting command, and what a held step needs from the person", async () => {
    state.data.instances = {
      items: [
        {
          id: "held",
          endpointSlug: "group-h",
          observedState: "STOPPING",
          desiredState: "STOPPED",
          agentsMayPreempt: false,
          needsOperator: "STEP",
          Nodes: [],
          operatorSteps: [
            {
              stepId: "stop",
              nodeId: "node-a",
              rank: 0,
              action: "stop",
              command: "sudo stop",
              state: "PENDING",
              heldResourceCheck: false,
              since: null,
              acceptedAt: null,
              overdue: false,
              terminalOpen: false,
              lastExit: null,
              // The gang-stop reason stays in errorCode; the hold says what to do.
              errorCode: "node_offline",
              hold: "operator_capability_missing",
              author: "agent",
            },
          ],
        },
      ],
      nextCursor: null,
    };
    show();
    expect(await screen.findByText("deploymentOperator.author.agent")).toBeTruthy();
    expect(screen.getByText("deploymentOperator.reasons.capabilityMissing")).toBeTruthy();
    expect(screen.queryByText("deploymentOperator.reasons.other")).toBeNull();
  });

  it("explains a restart that must wait for an earlier stop", async () => {
    state.errors.restart = Object.assign(new Error("waiting"), {
      code: "CONFLICT",
      data: { reason: "deployment_stop_pending" },
    });
    state.data.instances = {
      items: [
        {
          id: "stopped",
          endpointSlug: "group-b",
          observedState: "STOPPED",
          desiredState: "RUNNING",
          agentsMayPreempt: false,
          needsOperator: "RESTART",
          Nodes: [],
          operatorSteps: [],
        },
      ],
      nextCursor: null,
    };
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("button", { name: "deploymentOperator.restart" }));
    expect(await screen.findByText("deployments.stopPending")).toBeTruthy();
  });

  it("lists the commands a person will run before the plan is confirmed", async () => {
    state.data.pending = { items: [{ id: "plan-op" }], nextCursor: null };
    state.data.plan = {
      id: "plan-op",
      state: "AWAITING_CONFIRMATION",
      contents: {
        action: "start",
        stopIds: [],
        affectedNodeIds: ["node-a"],
        start: { revisionId: "rev", variantKey: "one" },
        warnings: ["interactive_operator_required", "interactive_operator_unavailable"],
        operatorSteps: [
          {
            instanceId: null,
            nodeId: "node-a",
            rank: 0,
            action: "start",
            command: "sudo start",
            nodeReady: true,
          },
          {
            instanceId: "old",
            nodeId: "node-b",
            rank: 0,
            action: "stop",
            command: "sudo stop",
            nodeReady: false,
          },
        ],
        operatorStepCount: 3,
      },
      preview: { start: { commands: [] }, agentEdited: false, stopped: [] },
    };
    const user = userEvent.setup();
    show();
    await user.click(
      await screen.findByRole("button", { name: /deployments.reviewPlan.*plan-op/ }),
    );
    const steps = await screen.findByTestId("plan-operator-steps");
    expect(within(steps).getByText("deploymentOperator.planStep")).toBeTruthy();
    expect(within(steps).getByText("deploymentOperator.planStopStep")).toBeTruthy();
    expect(within(steps).getByText("sudo stop")).toBeTruthy();
    expect(within(steps).getByText("deployments.operatorNodeNotReady")).toBeTruthy();
    expect(screen.getByText("deploymentOperator.moreSteps")).toBeTruthy();
  });

  it("keys every new group's operator steps apart", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const groupStep = (nodeId: string) => ({
      instanceId: null,
      nodeId,
      rank: 0,
      action: "start",
      command: "sudo start",
      nodeReady: true,
    });
    state.data.pending = { items: [{ id: "plan-groups" }], nextCursor: null };
    state.data.plan = {
      id: "plan-groups",
      state: "AWAITING_CONFIRMATION",
      contents: {
        action: "start",
        stopIds: [],
        affectedNodeIds: ["node-a", "node-b"],
        start: { revisionId: "rev", variantKey: "one" },
        warnings: ["interactive_operator_required"],
        // Two groups: both start on rank 0 and have no instance yet.
        operatorSteps: [groupStep("node-a"), groupStep("node-b"), groupStep("node-a")],
        operatorStepCount: 3,
      },
      preview: { start: { commands: [] }, agentEdited: false, stopped: [] },
    };
    const user = userEvent.setup();
    show();
    await user.click(
      await screen.findByRole("button", { name: /deployments.reviewPlan.*plan-groups/ }),
    );
    const steps = await screen.findByTestId("plan-operator-steps");
    expect(within(steps).getAllByText("deploymentOperator.planStep")).toHaveLength(3);
    expect(error.mock.calls.some((call) => String(call[0]).includes("same key"))).toBe(false);
    error.mockRestore();
  });

  it("warns after saving about interactive marks that never take effect", async () => {
    state.data.create = {
      id: "saved",
      interactiveWarnings: [
        { variant: "small", rank: null, command: "prepare", reason: "single_node" },
      ],
    };
    const user = userEvent.setup();
    show();
    await user.type(await screen.findByLabelText("deployments.name"), "Small");
    await user.type(screen.getByLabelText("deployments.slug"), "small");
    await user.selectOptions(screen.getByLabelText("deployments.pool"), "pool");
    const spec = screen.getByLabelText("deployments.spec");
    await user.clear(spec);
    await user.click(spec);
    await user.paste(JSON.stringify({ variants: [variant] }));
    await user.click(screen.getByRole("button", { name: "deployments.saveRecipe" }));
    expect(await screen.findByText(/deployments.interactiveFlagUnused/)).toBeTruthy();
    expect(screen.getByText(/deploymentOperator.unusedReasons.single_node/)).toBeTruthy();
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
          operatorSteps: [],
          needsOperator: null,
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
