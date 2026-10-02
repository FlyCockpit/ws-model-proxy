import { describe, expect, it } from "vitest";
import { normalizeLoginMachineId } from "./login-machine-id";

describe("normalizeLoginMachineId", () => {
  it("accepts a systemd machine-id and a UUID, lowercased and trimmed", () => {
    expect(normalizeLoginMachineId(" 0123456789ABCDEF0123456789ABCDEF\n")).toBe(
      "0123456789abcdef0123456789abcdef",
    );
    expect(normalizeLoginMachineId("AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE")).toBe(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    );
  });

  it.each([
    "",
    "   ",
    "uninitialized",
    "00000000000000000000000000000000",
    "00000000-0000-0000-0000-000000000000",
    "0123456789abcdef",
    "0123456789abcdef0123456789abcdef00",
    "not-a-machine",
    "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",
  ])("rejects %j", (raw) => {
    expect(normalizeLoginMachineId(raw)).toBeNull();
  });
});
