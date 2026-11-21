import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Checkbox } from "./checkbox";

describe("Checkbox touch target", () => {
  it("keeps its 16px visual while providing a centered 44px hit area", () => {
    const markup = renderToStaticMarkup(<Checkbox aria-label="Enabled" />);
    for (const token of [
      "size-4",
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
