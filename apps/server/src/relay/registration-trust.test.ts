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

  it("keeps who lowered a node that never said hello when its first hello says Full", () => {
    expect(trustLowerColumns(null, "FULL", true)).toEqual({});
  });

  it("ends a pending lowering when a never-seen node first reports Relay only", () => {
    expect(trustLowerColumns(null, "RELAY", true)).toEqual({ trustLowerRequestedAt: null });
  });
});
