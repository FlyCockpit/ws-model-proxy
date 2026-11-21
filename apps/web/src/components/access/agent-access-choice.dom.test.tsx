// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AGENT_SCOPES } from "@ws-model-proxy/api/contracts";
import { createInstance } from "i18next";
import { useState } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentScopeLabelKey, type EditableAgentAccess } from "@/lib/agent-access";
import en from "@/locales/en-US/access.json";
import es from "@/locales/es-MX/access.json";

vi.mock("@/utils/orpc", () => ({
  orpc: {
    nodes: {
      list: {
        queryOptions: () => ({
          queryKey: ["nodes"],
          queryFn: async () => ({
            nodes: [
              { id: "a", slug: "gpu-box", name: null },
              { id: "b", slug: "long-slug-".repeat(30), name: null },
              { id: "c", slug: "node-c", name: null },
              { id: "d", slug: "node-d", name: null },
            ],
          }),
        }),
      },
    },
  },
}));

import { AgentAccessChoice, AgentAccessSummary } from "./agent-access-choice";

afterEach(cleanup);

async function mount(lang: "en-US" | "es-MX", summary?: EditableAgentAccess) {
  const i18n = createInstance();
  await i18n.init({
    lng: lang,
    fallbackLng: false,
    resources: { "en-US": { access: en }, "es-MX": { access: es } },
  });
  function Choice() {
    const [value, setValue] = useState<EditableAgentAccess>({
      scopes: [...AGENT_SCOPES],
      nodeIds: null,
    });
    return <AgentAccessChoice value={value} onChange={setValue} />;
  }
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        {summary ? <AgentAccessSummary {...summary} /> : <Choice />}
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

describe("Agent access translations and node choices", () => {
  it.each(["en-US", "es-MX"] as const)(
    "renders every scope label and description without raw keys in %s",
    async (lang) => {
      const { container } = await mount(lang);
      const copy = lang === "en-US" ? en : es;
      for (const scope of AGENT_SCOPES) {
        const text = copy.agents.scopes[agentScopeLabelKey[scope]];
        const checkbox = screen.getByRole("checkbox", { name: `${text.name}${text.description}` });
        expect(checkbox.getAttribute("aria-checked")).toBe("true");
        expect(screen.getByText(text.description)).toBeTruthy();
      }
      expect(container.textContent).not.toMatch(/agents\.scopes|nodes\.manage|models\.test/);
      cleanup();
      const summary = await mount(lang, { scopes: [...AGENT_SCOPES], nodeIds: null });
      for (const scope of AGENT_SCOPES)
        expect(summary.container.textContent).toContain(
          copy.agents.scopes[agentScopeLabelKey[scope]].name,
        );
      expect(summary.container.textContent).not.toMatch(/agents\.scopes/);
    },
  );

  it("uses explicit empty and checked radio styling in dark mode and 44px label targets", async () => {
    document.documentElement.classList.add("dark");
    try {
      await mount("en-US");
      const all = screen.getByRole<HTMLInputElement>("radio", { name: en.agents.allNodes });
      const selected = screen.getByRole<HTMLInputElement>("radio", { name: en.agents.onlyNodes });
      expect(all.checked).toBe(true);
      expect(selected.checked).toBe(false);
      for (const radio of [all, selected]) {
        expect(radio.classList.contains("appearance-none")).toBe(true);
        expect(radio.classList.contains("bg-transparent")).toBe(true);
        expect(radio.classList.contains("border-muted-foreground")).toBe(true);
        expect(radio.classList.contains("dark:bg-input/30")).toBe(true);
        expect(radio.classList.contains("dark:checked:bg-primary")).toBe(true);
        expect(radio.classList.contains("checked:bg-primary")).toBe(true);
        expect(radio.closest("label")?.classList.contains("min-h-11")).toBe(true);
      }
      await userEvent.setup().click(selected);
      expect(selected.checked).toBe(true);
      expect(all.checked).toBe(false);
      expect(await screen.findByRole("checkbox", { name: "gpu-box" })).toBeTruthy();
    } finally {
      document.documentElement.classList.remove("dark");
    }
  });

  it("remembers node selections across all-nodes toggles while preserving scope edits", async () => {
    await mount("en-US");
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: en.agents.onlyNodes }));
    await user.click(await screen.findByRole("checkbox", { name: "gpu-box" }));
    await user.click(screen.getByRole("radio", { name: en.agents.allNodes }));
    expect(screen.queryByRole("checkbox", { name: "gpu-box" })).toBeNull();
    await user.click(
      screen.getByRole("checkbox", {
        name: `${en.agents.scopes.pools.name}${en.agents.scopes.pools.description}`,
      }),
    );
    await user.click(screen.getByRole("radio", { name: en.agents.onlyNodes }));
    expect(screen.getByRole("checkbox", { name: "gpu-box" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByRole("checkbox", { name: "node-c" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    await user.click(screen.getByRole("checkbox", { name: "gpu-box" }));
    await user.click(screen.getByRole("radio", { name: en.agents.allNodes }));
    await user.click(screen.getByRole("radio", { name: en.agents.onlyNodes }));
    expect(screen.getByRole("checkbox", { name: "gpu-box" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("keeps the separator attached to the inline node label", async () => {
    const { container } = await mount("en-US", { scopes: ["read"], nodeIds: ["a"] });
    const names = await screen.findByText("gpu-box");
    const group = names.parentElement;
    expect(group?.classList.contains("inline-flex")).toBe(true);
    expect(group?.textContent).toBe("·gpu-box");
    expect(group?.querySelector('[aria-hidden="true"]')?.textContent).toBe("·");
    expect(container.querySelector("p")?.textContent).toBe(
      `${en.agents.scopes.read.name} ·gpu-box`,
    );
  });

  it("omits the separator when there are no permission labels", async () => {
    const { container } = await mount("en-US", { scopes: [], nodeIds: null });
    expect(container.textContent).toBe(en.agents.allNodes);
    expect(container.textContent).not.toContain("·");
  });

  it("names up to three nodes and truncates long slugs", async () => {
    await mount("en-US", { scopes: ["read"], nodeIds: ["a", "b", "c"] });
    const names = await screen.findByText(`gpu-box, ${"long-slug-".repeat(30)}, node-c`);
    expect(names.classList.contains("truncate")).toBe(true);
    expect(names.getAttribute("title")).toContain("gpu-box");
  });

  it("keeps larger node lists compact with all slugs available in the title", async () => {
    const { container } = await mount("en-US", { scopes: ["read"], nodeIds: ["a", "b", "c", "d"] });
    const count = within(container).getByText("4 nodes");
    await screen.findByTitle(`gpu-box, ${"long-slug-".repeat(30)}, node-c, node-d`);
    expect(count.classList.contains("truncate")).toBe(true);
  });
});
