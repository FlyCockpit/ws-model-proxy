// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { DEVICE_LOGIN_REFUSAL_REASONS } from "@ws-model-proxy/config/cli-device-login";
import { DeviceLoginRefusal, DeviceLoginRequestDetails } from "./device-login-request";

afterEach(() => cleanup());

describe("DeviceLoginRequestDetails", () => {
  it("says approving adds a new device for the requested slug", () => {
    render(<DeviceLoginRequestDetails request={{ slug: "desk-01", existingDevice: null }} />);

    expect(screen.getByText("device.request.newTitle")).toBeTruthy();
    expect(screen.queryByText("device.request.replaceTitle")).toBeNull();
    expect(screen.queryByText("device.request.replaceNote")).toBeNull();
    expect(screen.getByText("desk-01").className).toContain("font-mono");
    expect(screen.getByText("device.request.checkSlug")).toBeTruthy();
  });

  it("says approving replaces the existing device's login and names it", () => {
    render(
      <DeviceLoginRequestDetails
        request={{
          slug: "desk-01",
          existingDevice: { id: "cli-1", slug: "desk-01", displayName: "Work laptop" },
        }}
      />,
    );

    expect(screen.getByText("device.request.replaceTitle")).toBeTruthy();
    expect(screen.queryByText("device.request.newTitle")).toBeNull();
    expect(screen.getByText("Work laptop")).toBeTruthy();
    expect(screen.getByText("desk-01")).toBeTruthy();
    // Terminals will re-verify the identity key if the login moved machines.
    expect(screen.getByText("device.request.replaceNote")).toBeTruthy();
  });
});

describe("DeviceLoginRefusal", () => {
  it.each(DEVICE_LOGIN_REFUSAL_REASONS)("says what happened and the next step for %s", (reason) => {
    render(<DeviceLoginRefusal reason={reason} onReload={() => {}} />);

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(`device.refusal.${reason}.title`)).toBeTruthy();
    expect(screen.getByText(`device.refusal.${reason}.next`)).toBeTruthy();
  });

  it("offers a reload only for a stale page, and it calls back", () => {
    const onReload = vi.fn();
    render(<DeviceLoginRefusal reason="slug_mismatch" onReload={onReload} />);

    fireEvent.click(screen.getByText("device.refusal.reload"));
    expect(onReload).toHaveBeenCalledTimes(1);

    cleanup();
    render(<DeviceLoginRefusal reason="expired" onReload={onReload} />);
    expect(screen.queryByText("device.refusal.reload")).toBeNull();
  });
});
