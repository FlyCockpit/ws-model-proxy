import { describe, expect, it } from "vitest";

import { poolSlugFor } from "./pool-ui";
import {
  firstOpenStep,
  nextStep,
  parseWelcomeStep,
  previousStep,
  shouldOfferWelcome,
} from "./welcome-steps";

const NONE = { node: false, runtime: false, pool: false, agent: false, apiKey: false };

describe("welcome steps", () => {
  it("parses only known steps", () => {
    expect(parseWelcomeStep("pool")).toBe("pool");
    expect(parseWelcomeStep("nope")).toBeUndefined();
    expect(parseWelcomeStep(3)).toBeUndefined();
  });

  it("opens the first step not done, or the last once all are", () => {
    expect(firstOpenStep(NONE)).toBe("node");
    expect(firstOpenStep({ ...NONE, node: true, runtime: true })).toBe("pool");
    expect(
      firstOpenStep({ node: true, runtime: true, pool: true, agent: true, apiKey: true }),
    ).toBe("apiKey");
  });

  it("walks the steps in order", () => {
    expect(nextStep("node")).toBe("runtime");
    expect(nextStep("apiKey")).toBeNull();
    expect(previousStep("node")).toBeNull();
    expect(previousStep("agent")).toBe("pool");
  });

  it("offers Welcome only to an account with nothing set up, once", () => {
    expect(shouldOfferWelcome({ done: false, steps: NONE }, false)).toBe(true);
    expect(shouldOfferWelcome({ done: false, steps: NONE }, true)).toBe(false);
    expect(shouldOfferWelcome({ done: true, steps: NONE }, false)).toBe(false);
    expect(shouldOfferWelcome({ done: false, steps: { ...NONE, apiKey: true } }, false)).toBe(
      false,
    );
  });
});

describe("poolSlugFor", () => {
  it("names the pool after the model, avoiding taken slugs", () => {
    expect(poolSlugFor("Qwen/Qwen3-32B", new Set())).toBe("qwen3-32b");
    expect(poolSlugFor("Qwen/Qwen3-32B", new Set(["qwen3-32b"]))).toBe("qwen3-32b-2");
    expect(poolSlugFor("Qwen/Qwen3-32B", new Set(["qwen3-32b", "qwen3-32b-2"]))).toBe(
      "qwen3-32b-3",
    );
    expect(poolSlugFor("llama3.1:8b", new Set())).toBe("llama3-1-8b");
    expect(poolSlugFor("///", new Set())).toBe("pool");
    const long = "a".repeat(60);
    expect(poolSlugFor(long, new Set(["a".repeat(41)]))).toBe(`${"a".repeat(39)}-2`);
  });
});
