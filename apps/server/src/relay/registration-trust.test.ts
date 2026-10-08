import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: {} }));

import { trustLowerColumns } from "./registration";

describe("trustLowerColumns", () => {
  it("ends a confirmed lowering but keeps who lowered it", () => {
    expect(trustLowerColumns("FULL", "RELAY", true)).toEqual({ trustLowerRequestedAt: null });
  });

  it("keeps a pending lowering while the node still reports Full control", () => {
    expect(trustLowerColumns("FULL", "FULL", true)).toEqual({});
  });

  it("forgets who lowered it when the node raises trust itself", () => {
    expect(trustLowerColumns("RELAY", "FULL", false)).toEqual({ trustLowerRequestedBy: null });
  });

  it("forgets who when the node lowers trust itself", () => {
    expect(trustLowerColumns("FULL", "RELAY", false)).toEqual({ trustLowerRequestedBy: null });
  });

  it("changes nothing when trust stays the same", () => {
    expect(trustLowerColumns("RELAY", "RELAY", false)).toEqual({});
  });
});
