// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  models: [] as Array<Record<string, unknown>>,
  pools: [] as Array<Record<string, unknown>>,
  isDesktop: false,
  lang: "en-US",
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      children,
      className,
      params,
      to,
    }: {
      children: ReactNode;
      className?: string;
      params?: { lang?: string };
      to: string;
    }) => (
      <a className={className} href={to.replace("$lang", params?.lang ?? "")}>
        {children}
      </a>
    ),
    createFileRoute: () => (options: { component: ComponentType }) => ({
      options,
      useParams: () => ({ lang: state.lang }),
    }),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/hooks/use-deployment-audience", () => ({
  useDeploymentAudience: () => ({ isAdmin: false }),
}));

vi.mock("@/utils/orpc", () => ({
  orpc: {
    appConfig: {
      queryOptions: () => ({
        queryKey: ["appConfig"],
        queryFn: async () => ({
          deploymentFeatures: { MODEL_API_ANTHROPIC_ENABLED: true },
        }),
        initialData: { deploymentFeatures: { MODEL_API_ANTHROPIC_ENABLED: true } },
      }),
    },
    forwarderManagement: {
      visibleModels: {
        queryOptions: () => ({
          queryKey: ["visibleModels"],
          initialData: { directModels: state.models, modelPools: state.pools },
          queryFn: async () => ({ directModels: state.models, modelPools: state.pools }),
        }),
      },
    },
  },
}));

vi.mock("@ws-model-proxy/ui/components/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div data-testid={className?.includes("w-80") ? "request-settings-popover" : undefined}>
      {children}
    </div>
  ),
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@ws-model-proxy/ui/components/drawer", () => ({
  Drawer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DrawerContent: ({
    children,
    overlayClassName,
  }: {
    children: ReactNode;
    overlayClassName?: string;
  }) => (
    <div>
      <div data-testid="drawer-overlay" className={overlayClassName} />
      <div data-testid="drawer-content">{children}</div>
    </div>
  ),
  DrawerDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DrawerHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DrawerTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/hooks/use-media-query", () => ({
  useIsDesktop: () => state.isDesktop,
}));

vi.mock("@ws-model-proxy/ui/components/command", () => ({
  Command: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandEmpty: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandInput: () => null,
  CommandItem: ({ children, onSelect }: { children: ReactNode; onSelect: () => void }) => (
    <button type="button" onClick={onSelect}>
      {children}
    </button>
  ),
  CommandList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/chat-markdown", () => ({
  ChatMarkdown: ({ content }: { content: string }) => <p>{content}</p>,
}));

vi.mock("@/hooks/use-chat-scroll-engine", () => ({
  useChatScrollEngine: () => ({
    contentRef: { current: null },
    hasOutOfViewUpdates: false,
    jumpToLatest: vi.fn(),
    liveEdgeRef: { current: null },
    markContentChanged: vi.fn(),
    markUserIntent: vi.fn(),
    positionTurnNearTop: vi.fn(),
    scrollRef: { current: null },
  }),
}));

vi.mock("@/lib/image-attachments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/image-attachments")>();
  return {
    ...actual,
    processImageFile: async () => ({
      ok: true as const,
      image: {
        id: "image-1",
        dataUrl: "data:image/png;base64,AA==",
        name: "image.png",
        byteSize: 2,
      },
    }),
  };
});

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { Route } from "./chat-test";

const directModel = {
  id: "direct-1",
  modelId: "owner/demo",
  upstreamModelId: "Demo model",
  target: "DIRECT_MODEL",
  attachmentModalities: { image: true, audio: false, video: false },
  maxAttachmentBytes: null,
  reasoning: {},
};

const poolModel = {
  id: "pool-1",
  modelId: "pool/demo",
  name: "Demo pool",
  target: "MODEL_POOL",
  attachmentModalities: { image: true, audio: false, video: false },
  maxAttachmentBytes: null,
  reasoning: {},
  compatibility: { recommendedSurface: "OPENAI_CHAT_COMPLETIONS" },
};

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Component = Route.options.component as ComponentType;
  const view = render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

afterEach(() => {
  cleanup();
  state.models = [];
  state.pools = [];
  state.isDesktop = false;
  state.lang = "en-US";
  vi.unstubAllGlobals();
});

describe("Chat Test quick wins", () => {
  it("keeps pool surface and routing controls inside desktop request settings", async () => {
    state.pools = [poolModel];
    state.isDesktop = true;
    await act(async () => {
      mount();
    });

    const settings = await screen.findByTestId("request-settings-popover", {}, { timeout: 5000 });
    expect(settings.querySelector("#chat-test-desktop-surface")).toBeTruthy();
    expect(settings.querySelector("#chat-test-desktop-routing-mode")).toBeTruthy();
    expect(document.querySelectorAll("select")).toHaveLength(2);
    expect(screen.getByText("Demo pool")).toBeTruthy();
    expect(screen.getAllByText("pool/demo").length).toBeGreaterThan(0);
    expect(screen.getByText("dashboard:chatTest.modelKinds.pool")).toBeTruthy();
  });

  it("keeps direct-model surface controls out of request settings", async () => {
    state.models = [directModel];
    state.isDesktop = true;
    await act(async () => {
      mount();
    });

    const settings = await screen.findByTestId("request-settings-popover", {}, { timeout: 5000 });
    expect(settings.querySelector("#chat-test-desktop-surface")).toBeNull();
    expect(settings.querySelector("#chat-test-desktop-routing-mode")).toBeNull();
  });

  it("uses a mobile-only drawer overlay", async () => {
    state.models = [directModel];
    await act(async () => {
      mount();
    });

    expect(screen.getByTestId("drawer-overlay").className).toContain("md:hidden");
  });

  it("shows a create-pool empty state when no models are available", async () => {
    state.models = [directModel];
    state.lang = "es-MX";
    let client: QueryClient;
    await act(async () => {
      ({ client } = mount());
    });

    await screen.findByText("Demo model");
    client!.setQueryData(["visibleModels"], { directModels: [], modelPools: [] });

    expect(await screen.findByText("dashboard:chatTest.emptyModels")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "dashboard:chatTest.createPool" }).getAttribute("href"),
    ).toBe("/es-MX/dashboard/pools/new");
    expect(screen.getByRole("link", { name: "dashboard:chatTest.createPool" }).className).toContain(
      "h-11",
    );
  });

  it("offers touch-sized sample prompts that populate the composer", async () => {
    state.models = [directModel];
    const user = userEvent.setup();
    await act(async () => {
      mount();
    });

    const sample = await screen.findByRole("button", {
      name: "dashboard:chatTest.samplePromptOne",
    });
    expect(sample.className).toContain("h-11");
    await user.click(sample);
    expect(
      (
        screen.getByRole("textbox", {
          name: "dashboard:chatTest.inputLabel",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("dashboard:chatTest.samplePromptOne");
  });

  it("makes attachment removal a 44px control", async () => {
    state.models = [directModel];
    await act(async () => {
      mount();
    });

    await screen.findByText("Demo model");
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "image.png", { type: "image/png" })] },
    });

    const remove = await screen.findByRole("button", {
      name: "dashboard:chatTest.attachments.remove",
    });
    expect(remove.className).toContain("size-11");
  });

  it("opens thinking while a streamed response is in progress", async () => {
    state.models = [directModel];
    const user = userEvent.setup();
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input.includes("/media/config")) {
          return new Response(
            JSON.stringify({ enabled: false, maxUploadBytes: 0, maxAttachmentBytes: 0 }),
          );
        }
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"reasoning_content":"thinking","content":"answer"}}]}\n\n',
              ),
            );
          },
        });
        return new Response(stream, { status: 200 });
      }),
    );
    await act(async () => {
      mount();
    });

    const composer = await screen.findByRole("textbox", { name: "dashboard:chatTest.inputLabel" });
    await user.type(composer, "Hello");
    await user.click(screen.getByRole("button", { name: "dashboard:chatTest.send" }));

    await waitFor(() => {
      const thinking = screen
        .getByText("dashboard:chatTest.reasoning.thinkingSummary")
        .closest("details");
      expect(thinking?.hasAttribute("open")).toBe(true);
    });
    await user.click(screen.getByRole("button", { name: "common:actions.copy" }));
    expect(clipboardWrite).toHaveBeenCalledWith("answer");
  });
});
