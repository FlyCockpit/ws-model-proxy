import { runtimeSpecSchema } from "@ws-model-proxy/api/lib/runtime-spec";
import { RUNTIME_SPEC_ISSUES } from "@ws-model-proxy/api/lib/spec-issues";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "../i18n";
import enValidation from "../locales/en-US/validation.json";
import esValidation from "../locales/es-MX/validation.json";
import { specIssueText } from "./spec-issue-text";

const placeholders = (text: string, pattern: RegExp) =>
  [...new Set([...text.matchAll(pattern)].map((match) => match[1]))].sort();

describe("runtime spec issue copy", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en-US");
  });

  it("has copy in both bundles for every issue id, with the API's values", () => {
    const bundles = { "en-US": enValidation.runtimeSpec, "es-MX": esValidation.runtimeSpec };
    for (const [id, english] of Object.entries(RUNTIME_SPEC_ISSUES)) {
      const values = placeholders(english, /\{(\w+)\}/g);
      for (const [locale, bundle] of Object.entries(bundles)) {
        const text: unknown = Reflect.get(bundle, id);
        expect(typeof text, `${locale} ${id}`).toBe("string");
        expect(placeholders(String(text), /\{\{(\w+)\}\}/g), `${locale} ${id}`).toEqual(values);
      }
    }
    expect(Object.keys(bundles["en-US"]).sort()).toEqual(Object.keys(RUNTIME_SPEC_ISSUES).sort());
  });

  it("shows a schema issue in the active language, with its values", async () => {
    const parsed = runtimeSpecSchema.safeParse({
      api: "openai",
      engine: "vllm",
      modelType: "llm",
      address: { baseUrl: "http://127.0.0.1:8000/" },
    });
    const issue = parsed.success
      ? undefined
      : parsed.error.issues.find((item) => item.path.join(".") === "address.baseUrl");
    expect(issue?.message).toBe("Write the address as http://127.0.0.1:8000.");

    i18n.addResourceBundle("es-MX", "validation", esValidation, true, true);
    await i18n.changeLanguage("es-MX");
    expect(issue && specIssueText(issue)).toBe("Escribe la dirección como http://127.0.0.1:8000.");
  });

  it("keeps the message of an issue without a localized id", () => {
    expect(specIssueText({ message: "Already localized." })).toBe("Already localized.");
    expect(specIssueText({ message: "x", params: { i18n: "noSuchId" } })).toBe("x");
  });
});
