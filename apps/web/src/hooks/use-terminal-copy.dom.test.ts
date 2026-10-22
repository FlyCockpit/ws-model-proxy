// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { toast } from "@ws-model-proxy/ui/components/sileo";

import { useUiPreferences } from "@/stores/ui-preferences";

import { useTerminalCopy } from "./use-terminal-copy";

const writeText = vi.fn<(text: string) => Promise<void>>();

/** Lets the delivery promise chains settle. */
const flush = () => act(async () => {});

describe("useTerminalCopy", () => {
  beforeEach(() => {
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    act(() => useUiPreferences.getState().setTerminalCopy("prompt"));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("waits for a click in prompt mode, then copies", async () => {
    const { result } = renderHook(() => useTerminalCopy());
    act(() => result.current.onCopy({ kind: "text", text: "hello" }));
    await flush();
    expect(result.current.pending?.text).toBe("hello");
    expect(writeText).not.toHaveBeenCalled();
    act(() => result.current.copyPending());
    await flush();
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(result.current.pending).toBeNull();
    expect(toast.success).toHaveBeenCalledWith("copyOut.copied");
  });

  it("does not copy when copying was turned off before the click", async () => {
    const { result } = renderHook(() => useTerminalCopy());
    act(() => result.current.onCopy({ kind: "text", text: "hello" }));
    await flush();
    act(() => useUiPreferences.getState().setTerminalCopy("off"));
    // Hidden while off.
    expect(result.current.pending).toBeNull();
    act(() => result.current.copyPending());
    await flush();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("drops a pending copy when cleared (dismiss or a new attach)", async () => {
    const { result } = renderHook(() => useTerminalCopy());
    act(() => result.current.onCopy({ kind: "text", text: "hello" }));
    await flush();
    act(() => result.current.clear());
    expect(result.current.pending).toBeNull();
  });

  it("never lets an older automatic copy that failed replace a newer one", async () => {
    act(() => useUiPreferences.getState().setTerminalCopy("auto"));
    let rejectFirst: (error: unknown) => void = () => undefined;
    writeText.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    writeText.mockRejectedValueOnce(new Error("needs a gesture"));
    const { result } = renderHook(() => useTerminalCopy());
    act(() => result.current.onCopy({ kind: "text", text: "older" }));
    act(() => result.current.onCopy({ kind: "text", text: "newer" }));
    await flush();
    expect(result.current.pending?.text).toBe("newer");
    act(() => rejectFirst(new Error("needs a gesture")));
    await flush();
    expect(result.current.pending?.text).toBe("newer");
  });

  it("explains a blocked copy when the browser has no Clipboard API", async () => {
    const { result } = renderHook(() => useTerminalCopy());
    act(() => result.current.onCopy({ kind: "text", text: "hello" }));
    await flush();
    vi.stubGlobal("navigator", {});
    act(() => result.current.copyPending());
    await flush();
    expect(toast.error).toHaveBeenCalledWith("copyOut.blocked");
  });
});
