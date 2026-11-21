import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Switch } from "./switch";

describe("Switch touch target", () => {
  it.each(["sm", "default"] as const)("provides a centered 44px hit area for size %s", (size) => {
    const markup = renderToStaticMarkup(<Switch size={size} aria-label="Enabled" />);
    expect(markup).toContain(`data-size="${size}"`);
    for (const token of [
      "relative",
      "after:absolute",
      "after:min-h-11",
      "after:min-w-11",
      "after:-translate-x-1/2",
      "after:-translate-y-1/2",
    ]) {
      expect(markup).toContain(token);
    }
  });
});
