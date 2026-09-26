import {
  catalogBlockReasons,
  catalogWarnReasons,
} from "@ws-model-proxy/api/lib/provider-catalog-model";
import { describe, expect, it } from "vitest";
import { PROVIDER_PRESETS } from "../components/provider-presets";
import enDashboard from "../locales/en-US/dashboard.json";
import esDashboard from "../locales/es-MX/dashboard.json";

function keyTree(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, nested]) =>
    keyTree(nested, prefix === "" ? key : `${prefix}.${key}`),
  );
}

describe("provider catalog locale parity (en-US / es-MX)", () => {
  it("has identical key trees", () => {
    expect(keyTree(esDashboard.providerCatalog)).toEqual(keyTree(enDashboard.providerCatalog));
  });

  it("has a label for every server verdict reason and every preset", () => {
    const reasons = [...catalogBlockReasons, ...catalogWarnReasons].sort();
    expect(Object.keys(enDashboard.providerCatalog.reasons).sort()).toEqual(reasons);
    for (const preset of PROVIDER_PRESETS)
      expect(enDashboard.providerCatalog.presets).toHaveProperty(preset.key);
  });

  it("keeps interpolation variables identical", () => {
    const variables = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/gu)].map((m) => m[1]);
    const en = keyTree(enDashboard.providerCatalog);
    for (const path of en) {
      const read = (bundle: unknown) =>
        path
          .split(".")
          .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], bundle);
      expect(variables(String(read(esDashboard.providerCatalog))).sort()).toEqual(
        variables(String(read(enDashboard.providerCatalog))).sort(),
      );
    }
  });
});
