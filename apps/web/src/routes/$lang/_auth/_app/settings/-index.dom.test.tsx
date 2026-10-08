// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  calls: [] as unknown[],
  navigations: [] as unknown[],
  languages: [] as string[],
  fail: false,
  sessionRefetches: 0,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (options: { component: ComponentType }) => ({ options }),
    useNavigate: () => async (to: unknown) => {
      state.navigations.push(to);
    },
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: {
      language: "en-US",
      changeLanguage: async (lang: string) => {
        state.languages.push(lang);
      },
    },
  }),
}));

vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({
    actions: {
      refetch: async () => {
        state.sessionRefetches += 1;
      },
    },
  }),
}));

vi.mock("@/i18n/use-namespace-t", () => ({ useNamespaceT: () => (key: string) => key }));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const SETTINGS = {
  name: "Ada",
  email: "ada@example.com",
  slug: "ada",
  locale: "en-US",
  operationalAlerts: false,
  twoFactorEnabled: false,
  onboardingDoneAt: null,
};

vi.mock("@/utils/orpc", () => ({
  orpc: {
    settings: {
      get: {
        queryKey: () => ["settings", "get"],
        queryOptions: () => ({ queryKey: ["settings", "get"], queryFn: async () => SETTINGS }),
      },
      update: {
        mutationOptions: (options?: Record<string, unknown>) => ({
          ...options,
          mutationFn: async (input: Record<string, unknown>) => {
            state.calls.push(input);
            if (state.fail) throw new Error("nope");
            return { ...SETTINGS, ...input };
          },
        }),
      },
    },
  },
}));

import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Route } from "./index";

async function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Component = Route.options.component as ComponentType & {
    preload?: () => Promise<unknown>;
  };
  await Component.preload?.();
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
  return (await screen.findByLabelText("settings:locale.label")) as HTMLSelectElement;
}

afterEach(() => {
  cleanup();
  state.calls = [];
  state.navigations = [];
  state.languages = [];
  state.fail = false;
  state.sessionRefetches = 0;
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
});

describe("settings locale", { timeout: 30_000 }, () => {
  it("shows the saved locale", async () => {
    const select = await mount();
    expect(select.value).toBe("en-US");
    expect(screen.getByRole("option", { name: "Español (México)" })).toBeTruthy();
  });

  it("saves a new locale, switches the UI and moves to its URL", async () => {
    const select = await mount();
    fireEvent.change(select, { target: { value: "es-MX" } });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("settings:locale.saved"));
    expect(state.calls).toEqual([{ locale: "es-MX" }]);
    expect(state.languages).toEqual(["es-MX"]);
    expect(state.navigations).toEqual([
      { to: "/$lang/settings", params: { lang: "es-MX" }, replace: true, resetScroll: false },
    ]);
    expect(window.localStorage.getItem("locale")).toBe("es-MX");
    expect(state.sessionRefetches).toBe(1);
  });

  it("keeps the page as it was when saving fails", async () => {
    state.fail = true;
    const select = await mount();
    fireEvent.change(select, { target: { value: "es-MX" } });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("settings:locale.saveError"));
    expect(state.navigations).toEqual([]);
    expect(state.languages).toEqual([]);
  });
});
