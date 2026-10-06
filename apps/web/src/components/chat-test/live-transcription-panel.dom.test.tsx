// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LiveTranscriptionPanel } from "./live-transcription-panel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const start = vi.fn(async () => {});
vi.mock("@/hooks/use-realtime-transcription", () => ({
  useRealtimeTranscription: () => ({
    state: { phase: "idle", items: [], problem: null },
    start,
    commit: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(),
  }),
}));

beforeEach(() => {
  start.mockClear();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LiveTranscriptionPanel", () => {
  it("explains when no model takes live sessions", () => {
    render(
      <LiveTranscriptionPanel open onOpenChange={() => {}} models={[]} modelsPending={false} />,
    );
    expect(screen.getByText("dashboard:chatTest.live.noModels")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /dashboard:chatTest.live.start/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("asks for no token: it starts the dashboard-signed session with the chosen model", () => {
    render(
      <LiveTranscriptionPanel
        open
        onOpenChange={() => {}}
        models={[{ modelId: "owner/asr", label: "ASR" }]}
        modelsPending={false}
      />,
    );
    expect(document.querySelector("input[type=password]")).toBeNull();
    expect(screen.queryByText(/token/i)).toBeNull();
    const button = screen.getByRole("button", { name: /dashboard:chatTest.live.start/ });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    expect(start).toHaveBeenCalledWith({ model: "owner/asr" });
  });
});
