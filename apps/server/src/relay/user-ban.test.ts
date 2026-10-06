import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancelNodeCommandsForUser: vi.fn(),
  cancelFileOpsForUser: vi.fn(),
}));
vi.mock("./node-commands.js", () => ({
  cancelNodeCommandsForUser: mocks.cancelNodeCommandsForUser,
}));
vi.mock("./node-file-ops.js", () => ({ cancelFileOpsForUser: mocks.cancelFileOpsForUser }));

const { cancelRelayWorkForBannedUser } = await import("./user-ban.js");

describe("cancelRelayWorkForBannedUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ends the user's node commands and file ops", () => {
    cancelRelayWorkForBannedUser("user-1");
    expect(mocks.cancelNodeCommandsForUser).toHaveBeenCalledWith("user-1");
    expect(mocks.cancelFileOpsForUser).toHaveBeenCalledWith("user-1");
  });

  it("still ends file ops when the command sweep throws", () => {
    mocks.cancelNodeCommandsForUser.mockImplementationOnce(() => {
      throw new Error("commands");
    });
    expect(() => cancelRelayWorkForBannedUser("user-1")).toThrow();
    expect(mocks.cancelFileOpsForUser).toHaveBeenCalledWith("user-1");
  });
});
