// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en-US" } }),
}));

import { useAppForm } from "@/hooks/use-app-form";
import { editorValues, readSpecEditor, type SpecReading } from "@/lib/runtime-spec-draft";

import { RuntimeSpecFields } from "./runtime-spec-fields";

const SPEC = {
  launch: {
    management: "service",
    groupSize: 1,
    resources: [{ kind: "unified", memoryGb: 100 }],
    labels: ["ds-head"],
    reservations: [
      { labels: ["ds-worker"], resources: { kind: "discrete", gpuCount: 2, vramGb: 80 } },
    ],
    commands: [{ start: "up", stop: "down", status: "check" }],
    health: { intervalMs: 15_000, failureThreshold: 3, successThreshold: 1 },
  },
};

function Host({ onRead }: { onRead: (reading: SpecReading) => void }) {
  const form = useAppForm({ defaultValues: { spec: editorValues(SPEC, "STARTABLE") } });
  return (
    <>
      <RuntimeSpecFields form={form} fields="spec" kind="STARTABLE" idPrefix="t" />
      <button
        type="button"
        onClick={() =>
          onRead(
            readSpecEditor(form.getFieldValue("spec"), "STARTABLE", {
              notJson: "not json",
              wrongKind: "wrong kind",
            }),
          )
        }
      >
        read
      </button>
    </>
  );
}

afterEach(() => {
  cleanup();
});

describe("RuntimeSpecFields reservations", () => {
  it("edits a discrete reservation's GPU vendor into the spec", () => {
    const onRead = vi.fn<(reading: SpecReading) => void>();
    render(<Host onRead={onRead} />);
    // The rank resource is unified (no vendor), so the only vendor select is the reservation's.
    const vendor = screen.getByLabelText("dashboard:runtime.specForm.vendor");
    expect(vendor.id).toBe("t-reservation-0-vendor");
    expect(vendor).toBeInstanceOf(HTMLSelectElement);
    if (!(vendor instanceof HTMLSelectElement)) return;
    expect(vendor.value).toBe("");
    fireEvent.change(vendor, { target: { value: "amd" } });
    fireEvent.click(screen.getByRole("button", { name: "read" }));
    const reading = onRead.mock.calls[0]?.[0];
    expect(reading?.ok).toBe(true);
    if (!reading?.ok) return;
    expect(reading.spec.launch?.reservations).toEqual([
      {
        labels: ["ds-worker"],
        resources: { kind: "discrete", gpuCount: 2, vramGb: 80, vendor: "amd" },
      },
    ]);
  });
});
