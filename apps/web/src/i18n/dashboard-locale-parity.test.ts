import { modelApiSurfaces } from "@ws-model-proxy/api/lib/surface-capabilities";
import { describe, expect, it } from "vitest";
import enDashboard from "../locales/en-US/dashboard.json";
import esDashboard from "../locales/es-MX/dashboard.json";

/**
 * Key-tree parity for the dashboard models surface labels: the provider
 * operations form renders `dashboard:models.surfaces.${surface}` dynamically
 * from the ModelApiSurface union, so every value the type system allows must
 * have a key in both bundles or the raw key leaks into the UI.
 */
function keyTree(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, nested]) =>
    keyTree(nested, prefix === "" ? key : `${prefix}.${key}`),
  );
}

describe("dashboard locale key parity (en-US / es-MX)", () => {
  it("has identical key trees for the models surfaces section", () => {
    expect(keyTree(esDashboard.models.surfaces)).toEqual(keyTree(enDashboard.models.surfaces));
  });

  it("contains the full models surfaces key set in both bundles", () => {
    const expected = ["ANTHROPIC_MESSAGES", "OPENAI_CHAT_COMPLETIONS", "OPENAI_RESPONSES"].sort();
    expect(keyTree(enDashboard.models.surfaces).sort()).toEqual(expected);
    expect(keyTree(esDashboard.models.surfaces).sort()).toEqual(expected);
  });

  it("labels every surface the ModelApiSurface union allows", () => {
    for (const surface of modelApiSurfaces) {
      expect(enDashboard.models.surfaces, `en-US missing label for ${surface}`).toHaveProperty(
        surface,
      );
      expect(esDashboard.models.surfaces, `es-MX missing label for ${surface}`).toHaveProperty(
        surface,
      );
    }
  });
});
