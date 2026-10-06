import { describe, expect, it } from "vitest";
import { RealtimeSessionCounters } from "./limits.js";

describe("realtime session counters", () => {
  it("caps per token, per user and per server, and releases once", () => {
    const counters = new RealtimeSessionCounters({ perToken: 2, perUser: 3, server: 4 });
    const a1 = counters.acquire({ tokenId: "a", userId: "u" });
    const a2 = counters.acquire({ tokenId: "a", userId: "u" });
    expect(counters.acquire({ tokenId: "a", userId: "u" })).toEqual({ ok: false, scope: "token" });
    const b1 = counters.acquire({ tokenId: "b", userId: "u" });
    expect(counters.acquire({ tokenId: "b", userId: "u" })).toEqual({ ok: false, scope: "user" });
    const c1 = counters.acquire({ tokenId: "c", userId: "v" });
    expect(counters.acquire({ tokenId: "d", userId: "w" })).toEqual({ ok: false, scope: "server" });
    for (const result of [a1, a2, b1, c1]) expect(result.ok).toBe(true);
    if (!a1.ok) throw new Error("unreachable");
    a1.admission.release();
    a1.admission.release();
    expect(counters.count({ tokenId: "a" })).toBe(1);
    expect(counters.count({ userId: "u" })).toBe(2);
    expect(counters.count("server")).toBe(3);
    expect(counters.acquire({ tokenId: "a", userId: "u" }).ok).toBe(true);
  });
});
