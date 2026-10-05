import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancelCommandsForUser: vi.fn(),
  cancelFileOpsForUser: vi.fn(),
  cancelDeploymentOperatorTerminalsForUser: vi.fn(),
}));
vi.mock("./cli-commands.js", () => ({ cancelCommandsForUser: mocks.cancelCommandsForUser }));
vi.mock("./cli-file-ops.js", () => ({ cancelFileOpsForUser: mocks.cancelFileOpsForUser }));
vi.mock("./session-manager.js", () => ({
  relaySessionManager: {
    cancelDeploymentOperatorTerminalsForUser: mocks.cancelDeploymentOperatorTerminalsForUser,
  },
}));

const { cancelRelayWorkForBannedUser } = await import("./user-ban.js");

describe("cancelRelayWorkForBannedUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("closes the user's deployment operator terminals with the rest of their work", () => {
    cancelRelayWorkForBannedUser("user-1");
    expect(mocks.cancelCommandsForUser).toHaveBeenCalledWith("user-1");
    expect(mocks.cancelFileOpsForUser).toHaveBeenCalledWith("user-1");
    expect(mocks.cancelDeploymentOperatorTerminalsForUser).toHaveBeenCalledWith("user-1");
  });

  it("still closes operator terminals when an earlier cancel throws", () => {
    mocks.cancelCommandsForUser.mockImplementationOnce(() => {
      throw new Error("commands");
    });
    mocks.cancelFileOpsForUser.mockImplementationOnce(() => {
      throw new Error("files");
    });
    expect(() => cancelRelayWorkForBannedUser("user-1")).toThrow();
    expect(mocks.cancelDeploymentOperatorTerminalsForUser).toHaveBeenCalledWith("user-1");
  });
});
