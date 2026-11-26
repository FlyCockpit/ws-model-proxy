import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  dismiss: vi.fn(),
  clear: vi.fn(),
}));
vi.mock("sileo", () => ({ sileo: backend }));

import { pillTitleBudget, titleOverflowsPill, toast } from "@ws-model-proxy/ui/lib/toast";

beforeEach(() => {
  for (const fn of Object.values(backend)) fn.mockReset();
});

describe("toast", () => {
  it("passes a short message as the title only", () => {
    toast.success("Saved");
    expect(backend.success).toHaveBeenCalledWith({ title: "Saved" });
  });

  it("repeats a long message in the description so the capped title row loses nothing", () => {
    // The provider page's warning after a refused key (D4 of e2e5-wmp): one line ran off both screen edges.
    const long =
      "Account added, but the key test failed: The provider refused the key. Copy the key again from the provider's site.";
    const onClick = vi.fn();
    toast.warning(long, { duration: 8000, action: { label: "Retry", onClick } });
    expect(backend.warning).toHaveBeenCalledWith({
      title: long,
      description: long,
      duration: 8000,
      button: { title: "Retry", onClick },
    });
  });

  it("measures the title against the pill when it can", () => {
    const budget = pillTitleBudget(16);
    expect(budget).toBe(350 - 10 - 24 - 24);
    expect(titleOverflowsPill("x", () => ({ width: budget * 0.9, budget }))).toBe(false);
    expect(titleOverflowsPill("x", () => ({ width: budget * 0.96, budget }))).toBe(true);
    // A larger root (4K scaling) leaves less room for the same text.
    expect(pillTitleBudget(24)).toBeLessThan(budget);
  });

  it("falls back to a length rule where nothing can be measured", () => {
    expect(titleOverflowsPill("a".repeat(40), () => null)).toBe(false);
    expect(titleOverflowsPill("a".repeat(41), () => null)).toBe(true);
  });
});

describe("toast title row (globals.css)", () => {
  const css = readFileSync(
    resolve(import.meta.dirname, "../../../../packages/ui/src/styles/globals.css"),
    "utf8",
  );

  it("caps the header row to the pill and ends a long title with an ellipsis", () => {
    expect(css).toMatch(
      /\[data-sileo-viewport\] \[data-sileo-header-inner\] \{\s*max-width: calc\(var\(--sileo-width\) - 1rem - 10px\);/,
    );
    expect(css).toMatch(
      /\[data-sileo-header-inner\] \[data-sileo-title\] \{\s*min-width: 0;\s*overflow: hidden;\s*text-overflow: ellipsis;/,
    );
  });

  it("shows titles as written, not in sileo's Title Case", () => {
    expect(css).toMatch(/\[data-sileo-viewport\] \[data-sileo-title\] \{\s*text-transform: none;/);
  });
});
