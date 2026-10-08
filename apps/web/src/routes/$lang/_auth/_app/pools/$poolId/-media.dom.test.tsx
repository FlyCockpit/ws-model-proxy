// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { poolFixture } from "./-pool-fixture";

const state = vi.hoisted(() => ({ update: vi.fn() }));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (options: { component: ComponentType }) => ({
      options,
      useParams: () => ({ lang: "en-US", poolId: "pool-1" }),
    }),
  };
});

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

const pool = poolFixture({
  sidecars: [
    {
      input: "IMAGE",
      targetPoolId: "pool-vision",
      targetCallableId: "ann/vision",
      prompt: "Describe it",
      timeoutMs: 20_000,
      maxAssets: 4,
    },
  ],
});

vi.mock("@/utils/orpc", () => ({
  orpc: {
    pools: {
      key: () => ["pools"],
      get: { queryOptions: () => ({ queryKey: ["pools", "get"], queryFn: async () => pool }) },
      list: {
        queryOptions: () => ({
          queryKey: ["pools", "list"],
          queryFn: async () => ({
            pools: [
              pool,
              poolFixture({ id: "pool-vision", slug: "vision", callableIds: ["ann/vision"] }),
              poolFixture({
                id: "pool-stt",
                slug: "stt",
                modelType: "TRANSCRIPTION",
                callableIds: ["ann/stt"],
              }),
            ],
            sharedWithMe: [],
          }),
        }),
      },
      update: {
        mutationOptions: () => ({
          mutationFn: async (input: unknown) => {
            state.update(input);
            return pool;
          },
        }),
      },
    },
  },
}));

import { Route } from "./media";

const Component = Route.options.component as ComponentType & {
  preload?: () => Promise<unknown>;
};

beforeAll(async () => {
  await Component.preload?.();
}, 30_000);

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
  await screen.findByText("dashboard:pool.media.pipeline");
}

afterEach(() => {
  cleanup();
  state.update.mockReset();
});

describe("pool media tab", () => {
  it("draws the pipeline: images through their sidecar, other media straight to the pool", async () => {
    await mount();
    const strip = screen.getByRole("list", { name: "dashboard:pool.media.pipeline" });
    const steps = within(strip).getAllByRole("listitem");
    expect(steps[0]?.textContent).toContain("ann/vision");
    expect(steps[0]?.textContent).toContain("dashboard:pool.media.as.IMAGE");
    expect(steps[0]?.textContent).toContain("ann/chat");
    expect(steps[1]?.textContent).toContain("dashboard:pool.media.direct");
  });

  it("shows the stored limits and saves new ones in milliseconds", async () => {
    await mount();
    const timeout = screen.getByLabelText("dashboard:pool.media.timeout") as HTMLInputElement;
    const maxAssets = screen.getByLabelText(
      "dashboard:pool.media.maxAssets.IMAGE",
    ) as HTMLInputElement;
    expect(timeout.value).toBe("20");
    expect(maxAssets.value).toBe("4");
    fireEvent.change(timeout, { target: { value: "45" } });
    fireEvent.change(maxAssets, { target: { value: "" } });
    fireEvent.click(
      screen.getAllByRole("button", { name: "common:actions.save" })[0] as HTMLElement,
    );
    await waitFor(() =>
      expect(state.update).toHaveBeenCalledWith({
        poolId: "pool-1",
        sidecars: [
          {
            input: "IMAGE",
            targetPoolId: "pool-vision",
            prompt: "Describe it",
            timeoutMs: 45_000,
            maxAssets: null,
          },
        ],
      }),
    );
  });

  it("refuses limits outside the allowed range", async () => {
    await mount();
    fireEvent.change(screen.getByLabelText("dashboard:pool.media.maxAssets.IMAGE"), {
      target: { value: "65" },
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: "common:actions.save" })[0] as HTMLElement,
    );
    await screen.findByText("dashboard:pool.media.rangeInvalid:1|64");
    expect(state.update).not.toHaveBeenCalled();
  });

  it("asks for limits only once a sidecar pool is picked", async () => {
    await mount();
    expect(screen.queryByLabelText("dashboard:pool.media.maxAssets.AUDIO")).toBeNull();
    fireEvent.change(
      screen.getByLabelText("dashboard:pool.media.target", { selector: "#sidecar-AUDIO" }),
      {
        target: { value: "pool-stt" },
      },
    );
    expect(await screen.findByLabelText("dashboard:pool.media.maxAssets.AUDIO")).toBeTruthy();
  });
});
