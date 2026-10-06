import { describe, expect, it } from "vitest";
import enAdmin from "../locales/en-US/admin.json";
import enDashboard from "../locales/en-US/dashboard.json";
import enNav from "../locales/en-US/nav.json";
import enSettings from "../locales/en-US/settings.json";
import esAdmin from "../locales/es-MX/admin.json";
import esDashboard from "../locales/es-MX/dashboard.json";
import esNav from "../locales/es-MX/nav.json";
import esSettings from "../locales/es-MX/settings.json";

/** Whole-namespace key-tree parity: no en-US fallback can leak into an es-MX page. */
function keyTree(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, nested]) =>
    keyTree(nested, prefix === "" ? key : `${prefix}.${key}`),
  );
}

describe("app locale key parity (en-US / es-MX)", () => {
  it.each([
    ["dashboard", enDashboard, esDashboard],
    ["nav", enNav, esNav],
    ["settings", enSettings, esSettings],
    ["admin", enAdmin, esAdmin],
  ])("has identical key trees in %s", (_name, en, es) => {
    expect(keyTree(es).sort()).toEqual(keyTree(en).sort());
  });

  it("names every app section with a label and a hint", () => {
    for (const nav of [enNav, esNav])
      for (const id of Object.keys(nav.hints))
        expect(nav.items[id as keyof typeof nav.items], id).toBeTypeOf("string");
  });

  it("uses the 0.4.0 words, never the retired ones, in the app pages", () => {
    const text = JSON.stringify([enDashboard, enNav]);
    for (const banned of [/\bCLI\b/, /\bdevices?\b/i, /\bdeployments?\b/i, /\bforwarders?\b/i])
      expect(banned.test(text), String(banned)).toBe(false);
  });
});
