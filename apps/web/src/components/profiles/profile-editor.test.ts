import { describe, expect, it, vi } from "vitest";

vi.mock("@/utils/orpc", () => ({ orpc: {} }));

import { PROFILE_SLUG_PATTERN, slugFromName } from "./profile-editor";

describe("slugFromName", () => {
  it.each([
    ["Evening gaming", "evening-gaming"],
    ["  2 Big GPUs!  ", "big-gpus"],
    ["Qwen / Llama", "qwen-llama"],
  ])("%s → %s", (name, slug) => {
    expect(slugFromName(name)).toBe(slug);
    expect(PROFILE_SLUG_PATTERN.test(slug)).toBe(true);
  });

  it("gives no valid slug for a name without letters", () => {
    expect(PROFILE_SLUG_PATTERN.test(slugFromName("123"))).toBe(false);
  });
});
