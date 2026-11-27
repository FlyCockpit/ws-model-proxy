import { describe, expect, it, vi } from "vitest";
import {
  notifyMachineCredentialsRevoked,
  onMachineCredentialsRevoked,
} from "./machine-credential-listeners";

describe("machine recovery listeners", () => {
  it("deduplicates, awaits each listener, isolates failure, logs only class, and unsubscribes", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fail = vi.fn(async () => {
      throw new TypeError("secret must not be logged");
    });
    const next = vi.fn(async () => {});
    const stop = onMachineCredentialsRevoked(fail);
    const duplicate = onMachineCredentialsRevoked(fail);
    const end = onMachineCredentialsRevoked(next);
    try {
      await notifyMachineCredentialsRevoked("u");
      expect(fail).toHaveBeenCalledExactlyOnceWith("u");
      expect(next).toHaveBeenCalledExactlyOnceWith("u");
      expect(log).toHaveBeenCalledExactlyOnceWith(
        "[auth] machine credential listener failed",
        "TypeError",
      );
      stop();
      duplicate();
      end();
      await notifyMachineCredentialsRevoked("u");
      expect(next).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      end();
      log.mockRestore();
    }
  });
});
