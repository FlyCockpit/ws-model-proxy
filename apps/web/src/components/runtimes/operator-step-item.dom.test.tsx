// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

import {
  OperatorStepItem,
  type OperatorStepView,
  operatorStepStatusKey,
} from "./operator-step-item";

afterEach(cleanup);

function step(overrides: Partial<OperatorStepView> = {}): OperatorStepView {
  return {
    id: "step-1",
    nodeNumber: 1,
    phase: "START",
    state: "AWAITING_OPERATOR",
    attempts: 1,
    errorCode: null,
    interactive: true,
    command: "sudo systemctl start llm@{{port}}",
    commandAuthor: "agent",
    rendered: { state: "ready", text: "sudo systemctl start llm@30001", nodeFills: [] },
    headAddr: null,
    terminalOpen: true,
    updatedAt: "2026-10-06T12:00:00.000Z",
    ...overrides,
  };
}

function renderItem(view: OperatorStepView, ready = true) {
  const handlers = { onAttach: vi.fn(), onReopen: vi.fn(), onCancel: vi.fn() };
  render(
    <OperatorStepItem
      step={view}
      runtimeName="LLM service"
      nodeLabel="box"
      since="2026-10-06T12:00:00.000Z"
      ready={ready}
      busy={false}
      {...handlers}
    />,
  );
  return handlers;
}

describe("OperatorStepItem", () => {
  it("shows the exact command and who wrote it before the person attaches", () => {
    const handlers = renderItem(step());
    expect(screen.getByText("terminals:steps.commandRendered")).toBeTruthy();
    expect(screen.getByText("sudo systemctl start llm@30001")).toBeTruthy();
    expect(screen.queryByText("sudo systemctl start llm@{{port}}")).toBeNull();
    expect(screen.getByText("terminals:steps.author.agent")).toBeTruthy();
    expect(screen.getByText("terminals:steps.waiting")).toBeTruthy();
    expect(screen.getByText("terminals:steps.passwordNote")).toBeTruthy();
    expect(screen.getByText("terminals:onNode:box", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "terminals:steps.attach" }));
    expect(handlers.onAttach).toHaveBeenCalledTimes(1);
    // An open terminal is answered or cancelled, not reopened.
    expect(screen.queryByRole("button", { name: "terminals:steps.reopen" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "terminals:steps.cancel" }));
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });

  it("offers Run again once the terminal closed", () => {
    const handlers = renderItem(step({ terminalOpen: false }));
    expect(screen.getByText("terminals:steps.closed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "terminals:steps.attach" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "terminals:steps.reopen" }));
    expect(handlers.onReopen).toHaveBeenCalledTimes(1);
  });

  it("never offers Cancel while the person's command runs", () => {
    renderItem(step({ state: "RUNNING" }));
    expect(screen.getByText("terminals:steps.running")).toBeTruthy();
    expect(screen.getByRole("button", { name: "terminals:steps.attach" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "terminals:steps.cancel" })).toBeNull();
  });

  it("waits for the terminal socket before taking a ticket", () => {
    renderItem(step(), false);
    const attach = screen.getByRole("button", { name: "terminals:steps.attach" });
    expect((attach as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains a held step", () => {
    expect(
      operatorStepStatusKey(
        step({ state: "PENDING", terminalOpen: false, errorCode: "operator_node_full" }),
      ),
    ).toBe("terminals:steps.hold.operator_node_full");
    expect(operatorStepStatusKey(step({ state: "PENDING", terminalOpen: false }))).toBe(
      "terminals:steps.queued",
    );
    renderItem(step({ state: "PENDING", terminalOpen: false, errorCode: "operator_node_full" }));
    expect(screen.getByText("terminals:steps.hold.operator_node_full")).toBeTruthy();
    expect(screen.getByRole("button", { name: "terminals:steps.cancel" })).toBeTruthy();
  });

  it("marks the values only the node fills in and shows the head address", () => {
    renderItem(
      step({
        command: "serve --host {{fabric_ip}} --head {{head_addr}}",
        rendered: {
          state: "ready",
          text: "serve --host {{fabric_ip}} --head 10.0.0.5",
          nodeFills: ["fabric_ip"],
        },
        headAddr: "10.0.0.5",
      }),
    );
    expect(screen.getByText("serve --host {{fabric_ip}} --head 10.0.0.5")).toBeTruthy();
    expect(screen.getByRole("note").textContent).toBe("terminals:steps.nodeFills:{{fabric_ip}}");
    expect(screen.getByText("terminals:steps.headAddr:10.0.0.5")).toBeTruthy();
  });

  it("says the node would refuse the step instead of showing a rendered command", () => {
    renderItem(
      step({ terminalOpen: false, rendered: { state: "refused", field: "placeholders.gpu_ids" } }),
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "terminals:steps.refused:placeholders.gpu_ids",
    );
    expect(screen.getByText("terminals:steps.template")).toBeTruthy();
    expect(screen.getByText("sudo systemctl start llm@{{port}}")).toBeTruthy();
    expect(screen.queryByText("sudo systemctl start llm@30001")).toBeNull();
    expect(screen.queryByText("terminals:steps.commandRendered")).toBeNull();
  });

  it("does not claim a refusal once the node opened the step's terminal", () => {
    renderItem(step({ rendered: { state: "refused", field: "fabricId" } }));
    expect(screen.getByRole("alert").textContent).toBe(
      "terminals:steps.refusedButOpen:fabricId terminals:steps.unavailableHint",
    );
  });

  it("shows only the template when the server cannot render the command faithfully", () => {
    renderItem(step({ rendered: { state: "unavailable", reason: "head_addr" } }));
    expect(screen.getByRole("alert").textContent).toBe(
      "terminals:steps.unavailable.head_addr terminals:steps.unavailableHint",
    );
    expect(screen.getByText("sudo systemctl start llm@{{port}}")).toBeTruthy();
    expect(screen.queryByText("terminals:steps.commandRendered")).toBeNull();
  });

  it("shows no command at all for a step of another definition", () => {
    renderItem(
      step({
        command: null,
        commandAuthor: null,
        rendered: { state: "unavailable", reason: "version" },
      }),
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "terminals:steps.unavailable.version terminals:steps.unavailableHint",
    );
    expect(screen.queryByText("terminals:steps.template")).toBeNull();
    expect(screen.queryByText(/systemctl/)).toBeNull();
  });
});
