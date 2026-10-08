// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/** Models: base URL with a snippet switcher, and a Test link per callable ID. */

const state = vi.hoisted(() => ({
  models: [] as Array<Record<string, unknown>>,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (options: { component: ComponentType }) => ({
      options,
      useParams: () => ({ lang: "en-US" }),
    }),
    Link: ({
      children,
      to,
      search,
      className,
      ...rest
    }: {
      children: ReactNode;
      to: string;
      search?: Record<string, string>;
      className?: string;
      "aria-label"?: string;
    }) => (
      <a
        href={search ? `${to}?${new URLSearchParams(search).toString()}` : to}
        className={className}
        aria-label={rest["aria-label"]}
      >
        {children}
      </a>
    ),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && "id" in opts ? `${key}:${String(opts.id)}` : key,
    i18n: { language: "en-US" },
  }),
}));

vi.mock("@/utils/orpc", () => ({
  orpc: {
    models: {
      list: {
        queryOptions: () => ({
          queryKey: ["models", "list"],
          queryFn: async () => ({ baseUrl: "https://proxy.example.com/v1", models: state.models }),
        }),
      },
    },
  },
}));

import { Route } from "./models";

function model(callableId: string, type = "LLM") {
  return {
    callableId,
    poolId: callableId,
    external: callableId.endsWith(":external"),
    type,
    owner: { slug: "me", you: true, email: null },
    status: "serving",
  };
}

const Component = (
  Route as unknown as { options: { component: ComponentType & { preload?: () => Promise<void> } } }
).options.component;

// The route component is code-split; load it once so renders do not suspend on a cold import.
beforeAll(async () => {
  await Component.preload?.();
}, 60_000);

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("Models page", () => {
  it("switches the header snippet between curl, the OpenAI SDK and the Anthropic SDK", async () => {
    state.models = [model("me/chat")];
    renderPage();
    const header = (await screen.findByText("dashboard:models.baseUrl")).closest(
      "[data-slot=card]",
    ) as HTMLElement;
    expect(
      within(header).getByText(/curl https:\/\/proxy\.example\.com\/v1\/chat\/completions/),
    ).toBeTruthy();

    fireEvent.click(
      within(header).getByRole("button", { name: "dashboard:models.snippets.openai" }),
    );
    expect(within(header).getByText(/base_url="https:\/\/proxy\.example\.com\/v1"/)).toBeTruthy();
    expect(within(header).getByText(/client\.chat\.completions\.create/)).toBeTruthy();

    fireEvent.click(
      within(header).getByRole("button", { name: "dashboard:models.snippets.anthropic" }),
    );
    // The Anthropic SDK adds /v1 itself.
    expect(
      within(header).getByText(/Anthropic\(base_url="https:\/\/proxy\.example\.com"/),
    ).toBeTruthy();
    expect(within(header).getByText(/model="me\/chat"/)).toBeTruthy();
  });

  it("explains that the Anthropic SDK calls chat models only", async () => {
    state.models = [model("me/embed", "EMBEDDINGS")];
    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "dashboard:models.snippets.anthropic" }),
    );
    expect(
      screen.getAllByText("dashboard:models.snippets.anthropicChatOnly").length,
    ).toBeGreaterThan(0);
  });

  it("links every callable ID to the Test page with it preselected", async () => {
    state.models = [model("me/chat"), model("me/chat:external")];
    renderPage();
    const chat = await screen.findByRole("link", { name: "dashboard:models.testOne:me/chat" });
    expect(chat.getAttribute("href")).toBe("/$lang/test?target=me%2Fchat");
    expect(
      screen
        .getByRole("link", { name: "dashboard:models.testOne:me/chat:external" })
        .getAttribute("href"),
    ).toBe("/$lang/test?target=me%2Fchat%3Aexternal");
  });
});
