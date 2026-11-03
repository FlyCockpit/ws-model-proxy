import { describe, expect, it, vi } from "vitest";
import { leaseOwnership } from "./lease-ownership.js";

describe("lease ownership", () => {
  it("releases an owned lease exactly once", () => {
    const release = vi.fn(() => "done");
    const lease = leaseOwnership(release);
    expect(lease.state).toBe("owned");
    expect(lease.release()).toBe("done");
    expect(lease.release()).toBeUndefined();
    expect(release).toHaveBeenCalledTimes(1);
    expect(lease.state).toBe("released");
  });

  it("never releases a transferred lease", () => {
    const release = vi.fn();
    const lease = leaseOwnership(release);
    expect(lease.transfer()).toBe(true);
    expect(lease.state).toBe("transferred");
    lease.release();
    expect(release).not.toHaveBeenCalled();
    expect(lease.state).toBe("transferred");
  });

  it("refuses to transfer a lease that is no longer owned", () => {
    const released = leaseOwnership(vi.fn());
    released.release();
    expect(released.transfer()).toBe(false);
    expect(released.state).toBe("released");

    const transferred = leaseOwnership(vi.fn());
    transferred.transfer();
    expect(transferred.transfer()).toBe(false);
  });
});
