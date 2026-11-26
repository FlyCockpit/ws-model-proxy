// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Node forms after the field triage: closed selects show labels, and the expert parts (hardware
 * override, ports and command limit, the add-node options) are folded away behind a summary.
 */

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}(${JSON.stringify(options)})` : key,
    i18n: { language: "en-US" },
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/x">{children}</a>,
}));
vi.mock("@ws-model-proxy/ui/components/responsive-dialog", () => ({
  ResponsiveDialog: ({
    open,
    title,
    children,
    footer,
  }: {
    open: boolean;
    title: ReactNode;
    children: ReactNode;
    footer?: ReactNode;
  }) =>
    open ? (
      <div role="dialog" aria-label={String(title)}>
        {children}
        <div data-testid="footer">{footer}</div>
      </div>
    ) : null,
}));
vi.mock("@/utils/orpc", () => {
  const mutation = { mutationOptions: (options?: object) => ({ ...options, mutationFn: vi.fn() }) };
  return {
    orpc: {
      nodes: {
        key: () => ["nodes"],
        update: mutation,
        enrollmentCodes: { key: () => ["codes"], create: mutation },
      },
    },
  };
});

import { AddNodeDialog } from "./add-node-dialog";
import { HardwareCard, PlacementCard } from "./node-definition-cards";
import type { NodeDetail } from "./node-types";

afterEach(cleanup);

const FULL: NodeDetail["trust"] = {
  reported: "FULL",
  effective: "FULL",
  lowerPending: false,
  frozen: false,
  changedAt: "2026-10-01T10:00:00.000Z",
  changedBy: null,
};

const detected = <T,>(value: T) => ({ value, source: "detected" as const });

/** Only the fields these cards read. */
function node(declaredHardware: NodeDetail["declaredHardware"] = null) {
  const partial: Pick<
    NodeDetail,
    | "id"
    | "slug"
    | "trust"
    | "labels"
    | "portRange"
    | "commandMaxMs"
    | "connection"
    | "declaredHardware"
    | "hardware"
  > = {
    id: "node-1",
    slug: "spark-1",
    trust: FULL,
    labels: ["gpu"],
    portRange: [20000, 20999],
    commandMaxMs: 2 * 3_600_000,
    connection: "ONLINE",
    declaredHardware,
    hardware: {
      kind: detected("discrete" as const),
      memoryGb: detected(64),
      acceleratorMemoryGb: detected(24),
      reservedMemoryGb: detected(0),
      gpus: [],
      usableMemoryGb: 62,
      reservedNowMemoryGb: 0,
      liveFreeMemoryGb: null,
      liveFreeAcceleratorGb: null,
    },
  };
  return partial as NodeDetail;
}

function mount(children: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>);
}

describe("HardwareCard", () => {
  it("folds the override away with what it holds, and its selects show labels", () => {
    mount(
      <HardwareCard
        node={node({ memoryGb: 96, gpus: [{ vendor: "nvidia", index: 0 }] })}
        lang="en-US"
      />,
    );
    const override = document.querySelector(
      'details[data-slot="advanced-section"]',
    ) as HTMLDetailsElement;
    expect(override.open).toBe(false);
    expect(override.textContent).toContain("dashboard:nodes.hardware.overrideTitle");
    expect(override.textContent).toContain("dashboard:nodes.hardware.overrideSet");
    expect(override.textContent).toContain("dashboard:nodes.hardware.overrideParts.memory");
    expect(override.textContent).toContain("96");
    // Base UI selects show the option's label when closed, never the raw value.
    const kind = screen.getByLabelText("dashboard:nodes.hardware.kind");
    expect(kind.textContent).toContain("dashboard:nodes.hardware.auto");
    const vendor = screen.getByLabelText("dashboard:nodes.hardware.gpuVendor");
    expect(vendor.textContent).toContain("dashboard:runtime.specForm.vendors.nvidia");
  });

  it("says the detected values rule when nothing is overridden", () => {
    mount(<HardwareCard node={node()} lang="en-US" />);
    const override = document.querySelector(
      'details[data-slot="advanced-section"]',
    ) as HTMLDetailsElement;
    expect(override.textContent).toContain("dashboard:nodes.hardware.overrideNone");
  });
});

describe("PlacementCard", () => {
  it("keeps labels up front and folds ports and the command limit behind their values", () => {
    mount(<PlacementCard node={node()} />);
    const labels = screen.getByLabelText("dashboard:nodes.definition.labels");
    expect(labels.closest("details")).toBeNull();
    const limits = document.querySelector(
      'details[data-slot="advanced-section"]',
    ) as HTMLDetailsElement;
    expect(limits.open).toBe(false);
    expect(limits.textContent).toContain('"start":"20000","end":"20999","hours":"2"');
    expect(screen.getByLabelText("dashboard:nodes.definition.portStart").closest("details")).toBe(
      limits,
    );
  });

  it("opens the folded limits and focuses the bad port when a save is refused", async () => {
    mount(<PlacementCard node={node()} />);
    const limits = document.querySelector(
      'details[data-slot="advanced-section"]',
    ) as HTMLDetailsElement;
    limits.open = true;
    const end = screen.getByLabelText("dashboard:nodes.definition.portEnd");
    fireEvent.change(end, { target: { value: "100" } });
    limits.open = false;
    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));
    await waitFor(() => expect(document.activeElement).toBe(end));
    expect(limits.open).toBe(true);
    expect(end.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(end.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "dashboard:nodes.definition.portsInvalid",
    );
  });
});

describe("AddNodeDialog", () => {
  it("asks only how many up front; options are folded with a summary and Create is pinned", () => {
    mount(<AddNodeDialog open onOpenChange={() => undefined} lang="en-US" />);
    const dialog = screen.getByRole("dialog");
    const options = dialog.querySelector(
      'details[data-slot="advanced-section"]',
    ) as HTMLDetailsElement;
    expect(options.open).toBe(false);
    expect(options.textContent).toContain("dashboard:nodes.add.summary.ttl");
    expect(options.textContent).toContain("dashboard:nodes.add.summary.noLabels");
    expect(options.textContent).toContain("dashboard:nodes.add.summary.kept");
    // The code lifetime select shows its label, not "1".
    const ttl = within(dialog).getByLabelText("dashboard:nodes.add.ttl");
    expect(ttl.textContent).toContain("dashboard:nodes.add.ttlOption.1");
    expect(
      within(screen.getByTestId("footer")).getByRole("button", {
        name: "dashboard:nodes.add.create",
      }),
    ).toBeTruthy();
  });

  it("keeps Create enabled for a bad label, then opens the options and focuses it", async () => {
    mount(<AddNodeDialog open onOpenChange={() => undefined} lang="en-US" />);
    const options = document.querySelector(
      'details[data-slot="advanced-section"]',
    ) as HTMLDetailsElement;
    options.open = true;
    const labels = screen.getByLabelText("dashboard:nodes.add.labels");
    fireEvent.change(labels, { target: { value: "Not A Label!" } });
    options.open = false;
    const create = within(screen.getByTestId("footer")).getByRole("button", {
      name: "dashboard:nodes.add.create",
    }) as HTMLButtonElement;
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    await waitFor(() => expect(document.activeElement).toBe(labels));
    expect(options.open).toBe(true);
    expect(labels.getAttribute("aria-describedby")).toContain("add-node-labels-error");
  });

  it("writes the temporary switch's state out and asks for the hours once it is on", () => {
    mount(<AddNodeDialog open onOpenChange={() => undefined} lang="en-US" />);
    const toggle = screen.getByRole("switch", { name: /dashboard:nodes\.add\.temporary/ });
    expect(toggle.closest("label")?.textContent).toContain("common:switchState.off");
    expect(screen.queryByLabelText("dashboard:nodes.add.offlineHours")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.closest("label")?.textContent).toContain("common:switchState.on");
    expect(screen.getByLabelText("dashboard:nodes.add.offlineHours")).toBeTruthy();
    const options = document.querySelector(
      'details[data-slot="advanced-section"]',
    ) as HTMLDetailsElement;
    expect(options.textContent).toContain("dashboard:nodes.add.summary.removed");
  });

  it("shows only the code lifetime when replacing a node", () => {
    mount(
      <AddNodeDialog
        open
        onOpenChange={() => undefined}
        lang="en-US"
        replace={{ nodeId: "node-1", slug: "spark-1" }}
      />,
    );
    expect(document.querySelector('details[data-slot="advanced-section"]')).toBeNull();
    expect(screen.getByLabelText("dashboard:nodes.add.ttl")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
