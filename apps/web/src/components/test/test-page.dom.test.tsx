// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Test page (`/$lang/test`): targets, deep links, streamed chat with reasoning, errors, embeddings, STT. */

const state = vi.hoisted(() => ({
  targets: [] as Array<Record<string, unknown>>,
  search: {} as { target?: string },
  navigations: [] as unknown[],
}));

vi.mock("@ws-model-proxy/env/web", () => ({ env: { VITE_SERVER_URL: "https://app.test" } }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && "count" in opts ? `${key}:${String(opts.count)}` : key,
    i18n: { language: "en-US" },
  }),
}));

vi.mock("@/utils/orpc", () => ({
  orpc: {
    models: {
      testTargets: {
        queryOptions: () => ({
          queryKey: ["models", "testTargets"],
          queryFn: async () => ({ targets: state.targets }),
        }),
      },
    },
  },
}));

import { TestPage } from "./test-page";

function target(overrides: Record<string, unknown> = {}) {
  return {
    model: "me/chat",
    source: "pool",
    label: "me/chat",
    servedModel: null,
    runtimeId: null,
    type: "LLM",
    status: "serving",
    external: false,
    capabilities: ["TEXT_GENERATION"],
    surfaces: ["OPENAI_CHAT_COMPLETIONS", "OPENAI_RESPONSES", "ANTHROPIC_MESSAGES"],
    recommendedSurface: "OPENAI_CHAT_COMPLETIONS",
    liveTranscription: false,
    maxAttachmentBytes: null,
    ...overrides,
  };
}

const DIRECT = target({
  model: "runtime:rt1:qwen",
  source: "runtime",
  label: "Qwen box",
  servedModel: "qwen",
  runtimeId: "rt1",
  surfaces: ["OPENAI_CHAT_COMPLETIONS"],
});

function sse(events: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(event));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const fetchMock = vi.fn<typeof fetch>();

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TestPage
        lang="en-US"
        target={state.search.target}
        onTargetChange={(target) => state.navigations.push(target)}
      />
    </QueryClientProvider>,
  );
}

function lastRequest() {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("no request");
  const [url, init] = call;
  return { url: String(url), init: init ?? {} };
}

beforeEach(() => {
  state.targets = [target(), DIRECT];
  state.search = {};
  state.navigations = [];
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Test page", () => {
  it("shows an empty state linking to Welcome and Pools when nothing can be tested", async () => {
    state.targets = [];
    renderPage();
    expect(await screen.findByText("dashboard:test.emptyTitle")).toBeTruthy();
    expect(screen.getByText("dashboard:test.goToWelcome").closest("a")?.getAttribute("href")).toBe(
      "/$lang/welcome",
    );
    expect(screen.getByText("dashboard:models.goToPools").closest("a")?.getAttribute("href")).toBe(
      "/$lang/pools",
    );
  });

  it("preselects the deep-linked target and puts a new choice in the URL", async () => {
    state.search = { target: "runtime:rt1:qwen" };
    renderPage();
    const select = (await screen.findByLabelText(
      "dashboard:test.target.label",
    )) as HTMLSelectElement;
    expect(select.value).toBe("runtime:rt1:qwen");
    expect(screen.getByText("dashboard:test.target.directPill")).toBeTruthy();
    // A direct model answers Chat Completions only: no API switcher.
    expect(screen.getByText("dashboard:test.surface.only")).toBeTruthy();
    fireEvent.change(select, { target: { value: "me/chat" } });
    expect(state.navigations).toEqual(["me/chat"]);
  });

  it("says when the deep-linked target is not testable and falls back to the first", async () => {
    state.search = { target: "someone/else" };
    renderPage();
    expect(await screen.findByText("dashboard:test.target.missing")).toBeTruthy();
    expect((screen.getByLabelText("dashboard:test.target.label") as HTMLSelectElement).value).toBe(
      "me/chat",
    );
  });

  it("streams a chat answer with its reasoning and timings", async () => {
    fetchMock.mockResolvedValue(
      sse([
        'data: {"choices":[{"delta":{"reasoning_content":"Thinking hard."}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo!"}}]}\n\n',
        'data: {"choices":[],"usage":{"completion_tokens":3}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    renderPage();
    const box = await screen.findByLabelText("dashboard:test.chat.message");
    fireEvent.change(box, { target: { value: "Say hello" } });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:test.chat.send" }));
    expect(await screen.findByText("Hello!")).toBeTruthy();
    expect(screen.getByText("Thinking hard.")).toBeTruthy();
    expect(screen.getByText("dashboard:test.chat.reasoning")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/dashboard:test\.metrics\.tokens:3/)).toBeTruthy());
    const { url, init } = lastRequest();
    expect(url).toBe("https://app.test/api/internal/chat-test/chat/completions");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "me/chat",
      stream: true,
      messages: [{ role: "user", content: "Say hello" }],
    });
  });

  it("speaks Anthropic Messages when chosen, streaming text and thinking", async () => {
    fetchMock.mockResolvedValue(
      sse([
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Hmm."}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi there"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    );
    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "dashboard:test.surface.ANTHROPIC_MESSAGES" }),
    );
    fireEvent.change(screen.getByLabelText("dashboard:test.chat.message"), {
      target: { value: "Hi" },
    });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:test.chat.send" }));
    expect(await screen.findByText("Hi there")).toBeTruthy();
    expect(screen.getByText("Hmm.")).toBeTruthy();
    const { url, init } = lastRequest();
    expect(url).toBe("https://app.test/api/internal/chat-test/messages");
    expect(new Headers(init.headers).get("anthropic-version")).toBe("2023-06-01");
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "me/chat",
      stream: true,
      max_tokens: 1024,
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    });
  });

  it("shows a failed request with the model server's own error quoted", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: "The model failed.",
            code: "upstream_error",
            upstream_error: "max_tokens must be at most 4096",
          },
        }),
        { status: 502, headers: { "content-type": "application/json" } },
      ),
    );
    renderPage();
    fireEvent.change(await screen.findByLabelText("dashboard:test.chat.message"), {
      target: { value: "Hi" },
    });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:test.chat.send" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("The model failed.")).toBeTruthy();
    expect(within(alert).getByText("HTTP 502 · upstream_error")).toBeTruthy();
    expect(within(alert).getByText("dashboard:test.errors.upstream")).toBeTruthy();
    expect(within(alert).getByText("max_tokens must be at most 4096")).toBeTruthy();
  });

  it("leaves a failed exchange out of the next turn's history", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Too many requests." }), { status: 429 }),
      )
      .mockResolvedValueOnce(sse(['data: {"choices":[{"delta":{"content":"Fine."}}]}\n\n']));
    renderPage();
    const box = await screen.findByLabelText("dashboard:test.chat.message");
    fireEvent.change(box, { target: { value: "first" } });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:test.chat.send" }));
    // The app's own guards answer { error: "..." }.
    expect(await screen.findByText("Too many requests.")).toBeTruthy();
    fireEvent.change(box, { target: { value: "second" } });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:test.chat.send" }));
    expect(await screen.findByText("Fine.")).toBeTruthy();
    expect(JSON.parse(String(lastRequest().init.body)).messages).toEqual([
      { role: "user", content: "second" },
    ]);
  });

  it("summarizes an embeddings answer", async () => {
    state.targets = [
      target({ model: "me/embed", label: "me/embed", type: "EMBEDDINGS", surfaces: [] }),
    ];
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { index: 0, embedding: [1, 0, 0] },
            { index: 1, embedding: [1, 0, 0] },
          ],
          usage: { prompt_tokens: 7 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    renderPage();
    fireEvent.change(await screen.findByLabelText("dashboard:test.embeddings.label"), {
      target: { value: "first\n\nsecond\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:test.embeddings.send" }));
    const result = await screen.findByRole("region", { name: "dashboard:test.embeddings.result" });
    expect(within(result).getByText(/dashboard:test\.embeddings\.vectors:2/)).toBeTruthy();
    expect(within(result).getByText(/dashboard:test\.embeddings\.dimensions:3/)).toBeTruthy();
    expect(within(result).getByText("dashboard:test.embeddings.similarity")).toBeTruthy();
    const { url, init } = lastRequest();
    expect(url).toBe("https://app.test/api/internal/chat-test/embeddings");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "me/embed",
      input: ["first", "second"],
    });
  });

  it("transcribes an uploaded file and offers the live panel where supported", async () => {
    state.targets = [
      target({
        model: "me/stt",
        label: "me/stt",
        type: "TRANSCRIPTION",
        surfaces: [],
        liveTranscription: true,
      }),
    ];
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ text: "hello world" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    renderPage();
    expect(await screen.findByRole("button", { name: "dashboard:test.live.start" })).toBeTruthy();
    const file = new File(["RIFF"], "clip.wav", { type: "audio/wav" });
    fireEvent.change(screen.getByLabelText("dashboard:test.transcription.file"), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:test.transcription.send" }));
    expect(await screen.findByText("hello world")).toBeTruthy();
    const { url, init } = lastRequest();
    expect(url).toBe("https://app.test/api/internal/chat-test/audio/transcriptions");
    const form = init.body as FormData;
    expect(form.get("model")).toBe("me/stt");
    expect((form.get("file") as File).name).toBe("clip.wav");
  });

  it("asks for a file before transcribing and explains when live is unavailable", async () => {
    state.targets = [
      target({ model: "me/stt", label: "me/stt", type: "TRANSCRIPTION", surfaces: [] }),
    ];
    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "dashboard:test.transcription.send" }),
    );
    expect(await screen.findByText("dashboard:test.transcription.fileRequired")).toBeTruthy();
    expect(screen.getByText("dashboard:test.live.unsupported")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
