// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

type Layout = { tabs: string[]; nodes: string[] };

const getFn = vi.fn<() => Promise<Layout>>();
const updateFn = vi.fn<(input: Partial<Layout>) => Promise<Layout>>();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@ws-model-proxy/ui/lib/toast", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    settings: {
      terminalLayout: {
        get: {
          queryKey: () => ["terminalLayout"],
          queryOptions: () => ({ queryKey: ["terminalLayout"], queryFn: () => getFn() }),
        },
        update: {
          mutationOptions: () => ({ mutationFn: (input: Partial<Layout>) => updateFn(input) }),
        },
      },
    },
  },
}));

import { useTerminalLayout } from "./use-terminal-layout";

afterEach(() => {
  cleanup();
  getFn.mockReset();
  updateFn.mockReset();
});

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, ...renderHook(() => useTerminalLayout(), { wrapper }) };
}

describe("useTerminalLayout", () => {
  it("ignores a move before the saved order has loaded", () => {
    getFn.mockReturnValue(new Promise<Layout>(() => {}));
    const { result } = setup();
    expect(result.current.ready).toBe(false);
    let saved: string[] | null = [];
    act(() => {
      saved = result.current.saveTabOrder(["b", "a"]);
    });
    expect(saved).toBeNull();
    act(() => {
      saved = result.current.saveNodeOrder(["n2", "n1"]);
    });
    expect(saved).toBeNull();
    expect(updateFn).not.toHaveBeenCalled();
  });

  it("ignores a move after the saved order failed to load", async () => {
    getFn.mockRejectedValue(new Error("down"));
    const { result } = setup();
    await waitFor(() => expect(getFn).toHaveBeenCalled());
    await act(async () => {});
    expect(result.current.ready).toBe(false);
    act(() => {
      result.current.saveTabOrder(["b", "a"]);
    });
    expect(updateFn).not.toHaveBeenCalled();
  });

  it("after load, saves the moved order and keeps the place of terminals not shown", async () => {
    getFn.mockResolvedValue({ tabs: ["a", "offline", "b"], nodes: ["n1", "n2"] });
    updateFn.mockImplementation(async (input) => ({ tabs: [], nodes: [], ...input }));
    const { result, client } = setup();
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => {
      result.current.saveTabOrder(["b", "a", null]);
    });
    await waitFor(() => expect(updateFn).toHaveBeenCalledTimes(1));
    expect(updateFn.mock.calls[0]?.[0]).toEqual({ tabs: ["b", "a", "offline"] });
    await waitFor(() => expect(result.current.tabOrder).toEqual(["b", "a", "offline"]));
    expect(client.getQueryData(["terminalLayout"])).toEqual({
      tabs: ["b", "a", "offline"],
      nodes: ["n1", "n2"],
    });
  });

  it("stays ready when a background refetch fails after the order loaded", async () => {
    getFn.mockResolvedValueOnce({ tabs: ["a", "b"], nodes: [] });
    updateFn.mockImplementation(async (input) => ({ tabs: [], nodes: [], ...input }));
    const { result, client } = setup();
    await waitFor(() => expect(result.current.ready).toBe(true));
    getFn.mockRejectedValueOnce(new Error("down"));
    await act(async () => {
      await client.refetchQueries({ queryKey: ["terminalLayout"] });
    });
    expect(client.getQueryState(["terminalLayout"])?.status).toBe("error");
    expect(result.current.ready).toBe(true);
    act(() => {
      result.current.saveTabOrder(["b", "a"]);
    });
    await waitFor(() => expect(updateFn).toHaveBeenCalledTimes(1));
  });

  it("cancels a refetch in flight so it cannot undo the move", async () => {
    getFn.mockResolvedValueOnce({ tabs: ["a", "b"], nodes: [] });
    updateFn.mockImplementation(async (input) => ({ tabs: [], nodes: [], ...input }));
    const { result, client } = setup();
    await waitFor(() => expect(result.current.ready).toBe(true));
    let resolveRefetch: (layout: Layout) => void = () => {};
    getFn.mockReturnValueOnce(
      new Promise<Layout>((resolve) => {
        resolveRefetch = resolve;
      }),
    );
    act(() => {
      void client.refetchQueries({ queryKey: ["terminalLayout"] });
    });
    act(() => {
      result.current.saveTabOrder(["b", "a"]);
    });
    await waitFor(() => expect(result.current.tabOrder).toEqual(["b", "a"]));
    await act(async () => {
      resolveRefetch({ tabs: ["a", "b"], nodes: [] });
    });
    expect(client.getQueryData(["terminalLayout"])).toEqual({ tabs: ["b", "a"], nodes: [] });
  });
});
