import { describe, expect, it } from "vitest";
import { clientCredential } from "./client-credential.js";

const of = (headers: Record<string, string>) => clientCredential(new Headers(headers));

describe("client credential", () => {
  it("reads Bearer, x-api-key and api-key", () => {
    expect(of({ authorization: "Bearer wsmp_k" })).toEqual({ kind: "key", key: "wsmp_k" });
    expect(of({ authorization: "bearer   wsmp_k " })).toEqual({ kind: "key", key: "wsmp_k" });
    expect(of({ "x-api-key": "wsmp_k" })).toEqual({ kind: "key", key: "wsmp_k" });
    expect(of({ "api-key": " wsmp_k " })).toEqual({ kind: "key", key: "wsmp_k" });
    expect(of({})).toEqual({ kind: "none" });
  });

  it("accepts the same key twice and refuses two different keys", () => {
    expect(of({ authorization: "Bearer wsmp_k", "x-api-key": "wsmp_k" })).toEqual({
      kind: "key",
      key: "wsmp_k",
    });
    expect(of({ authorization: "Bearer wsmp_a", "x-api-key": "wsmp_b" })).toEqual({
      kind: "conflict",
    });
    expect(of({ "x-api-key": "wsmp_a", "api-key": "wsmp_b" })).toEqual({ kind: "conflict" });
  });

  it("refuses a malformed Authorization or an empty key header", () => {
    expect(of({ authorization: "Basic abc" })).toEqual({ kind: "conflict" });
    expect(of({ authorization: "Bearer a b" })).toEqual({ kind: "conflict" });
    expect(of({ "x-api-key": "" })).toEqual({ kind: "conflict" });
  });
});
