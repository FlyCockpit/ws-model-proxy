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

  it("starts only with a model API token, and passes it to the session, not the page", () => {
    render(
      <LiveTranscriptionPanel
        open
        onOpenChange={() => {}}
        models={[{ modelId: "owner/asr", label: "ASR" }]}
        modelsPending={false}
      />,
    );
    const button = screen.getByRole("button", { name: /dashboard:chatTest.live.start/ });
    const input = screen.getByLabelText("dashboard:chatTest.live.token") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: "not-a-token" } });
    expect(screen.getByText("dashboard:chatTest.live.tokenInvalid")).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "wsmp_model_abcdefghIJKL" } });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    expect(start).toHaveBeenCalledWith({ token: "wsmp_model_abcdefghIJKL", model: "owner/asr" });
  });
});
