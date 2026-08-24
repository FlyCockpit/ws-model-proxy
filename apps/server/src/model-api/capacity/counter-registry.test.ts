import { describe, expect, it, vi } from "vitest";
import { ContextCounterRegistry } from "./counter-registry.js";

const identity = {
  runtimeIdentityKey: "runtime",
  runtimeModel: "model",
  runtimeRevision: "r1",
  tokenizer: "tok",
  tokenizerVersion: "v1",
  template: "chat",
  templateVersion: "v1",
};

describe("ContextCounterRegistry", () => {
  it("matches the complete runtime/tokenizer/template identity", () => {
    const registry = new ContextCounterRegistry();
    const counter = { count: vi.fn() };
    registry.register(identity, counter);
    expect(registry.resolve(identity)).toBe(counter);
    expect(registry.resolve({ ...identity, runtimeRevision: "r2" })).toBeNull();
    expect(registry.resolve({ ...identity, templateVersion: "v2" })).toBeNull();
  });

  it("allows safe unregister without removing a replacement", () => {
    const registry = new ContextCounterRegistry();
    const first = { count: vi.fn() };
    const second = { count: vi.fn() };
    const unregisterFirst = registry.register(identity, first);
    registry.register(identity, second);
    unregisterFirst();
    expect(registry.resolve(identity)).toBe(second);
  });
});
