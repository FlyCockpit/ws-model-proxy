import { describe, expect, it, vi } from "vitest";

// Pool of 3 → two lock slots.
vi.mock("@ws-model-proxy/env/shared", () => ({ env: { DATABASE_POOL_MAX: 3 } }));

const { LockSlotTimeoutError, releaseSlots, tryAcquireSlots, withLockSlot } = await import(
  "./lock-slots"
);

const { configureLockSlots } = await import("./lock-slots");
configureLockSlots(3);

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

describe("lock slots", () => {
  it("a holder that reserved a nested slot runs its nested lock transaction without waiting", async () => {
    const order: string[] = [];
    const first = gate();
    // Two holders that each run a nested lock transaction (a password write
    // and its revocation). With 2 slots, holding one each and waiting for a
    // second would deadlock; reserving both up front serializes them.
    const holder = (name: string, wait: Promise<void>) =>
      withLockSlot(
        async () => {
          order.push(`${name}:in`);
          await wait;
          await withLockSlot(async () => {
            order.push(`${name}:nested`);
          });
        },
        { nested: 1 },
      );
    const a = holder("a", first.opened);
    const b = holder("b", Promise.resolve());
    await Promise.resolve();
    expect(order).toEqual(["a:in"]);
    // Both slots are A's: nothing else gets one meanwhile.
    expect(tryAcquireSlots()).toBe(false);
    first.open();
    await Promise.all([a, b]);
    expect(order).toEqual(["a:in", "a:nested", "b:in", "b:nested"]);
    expect(tryAcquireSlots(2)).toBe(true);
    releaseSlots(2);
  });

  it("hands slots to waiters in arrival order and never lets a try jump the queue", async () => {
    expect(tryAcquireSlots()).toBe(true);
    const order: string[] = [];
    const pair = withLockSlot(async () => order.push("pair"), { nested: 1 });
    // One slot is free, but the pair waiting for two is first in line.
    expect(tryAcquireSlots()).toBe(false);
    const single = withLockSlot(async () => order.push("single"));
    releaseSlots();
    await Promise.all([pair, single]);
    expect(order).toEqual(["pair", "single"]);
    expect(tryAcquireSlots(2)).toBe(true);
    releaseSlots(2);
  });

  it("a waiter past its deadline leaves the queue and stops holding up the ones behind it", async () => {
    expect(tryAcquireSlots(2)).toBe(true);
    const order: string[] = [];
    const pair = withLockSlot(async () => order.push("pair"), {
      nested: 1,
      deadline: performance.now() + 50,
    });
    const single = withLockSlot(async () => order.push("single"));
    // One slot frees up, but the pair at the head needs two.
    releaseSlots();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual([]);
    await expect(pair).rejects.toBeInstanceOf(LockSlotTimeoutError);
    // The expired pair is gone, so the single behind it got the free slot.
    await single;
    expect(order).toEqual(["single"]);
    releaseSlots();
    expect(tryAcquireSlots(2)).toBe(true);
    releaseSlots(2);
  });

  it("a waiter admitted before its deadline runs normally", async () => {
    expect(tryAcquireSlots(2)).toBe(true);
    const waited = withLockSlot(async () => "ran", { deadline: performance.now() + 1_000 });
    releaseSlots(2);
    await expect(waited).resolves.toBe("ran");
    expect(tryAcquireSlots(2)).toBe(true);
    releaseSlots(2);
  });
});

it.each(["reservation", "transaction ticket"])(
  "a detached continuation cannot reuse an expired %s",
  async (kind) => {
    const { withTransactionSlot } = await import("./lock-slots");
    const delayed = gate();
    let ran = false;
    let continuation!: Promise<void>;
    await withLockSlot(
      async () => {
        continuation = delayed.opened.then(() =>
          (kind === "reservation" ? withLockSlot : withTransactionSlot)(async () => {
            ran = true;
          }),
        );
      },
      { nested: 1 },
    );
    expect(tryAcquireSlots(2)).toBe(true);
    delayed.open();
    await Promise.resolve();
    await Promise.resolve();
    expect(ran).toBe(false);
    releaseSlots(2);
    await continuation;
    expect(ran).toBe(true);
  },
);

it("concurrent children wait FIFO for the live reservation's borrowed spare", async () => {
  const entered = gate();
  const release = gate();
  const order: string[] = [];
  const outer = withLockSlot(
    async () => {
      const first = withLockSlot(async () => {
        order.push("first");
        entered.open();
        await release.opened;
      });
      await entered.opened;
      const second = withLockSlot(
        async () => {
          order.push("second");
        },
        { deadline: performance.now() + 1_000 },
      );
      const third = withLockSlot(
        async () => {
          order.push("third");
        },
        { deadline: performance.now() + 1_000 },
      );
      expect(order).toEqual(["first"]);
      release.open();
      await Promise.all([first, second, third]);
    },
    { nested: 1 },
  );
  await entered.opened;
  const global = withLockSlot(async () => {
    order.push("global");
  });
  await expect(outer).resolves.toBeUndefined();
  await global;
  expect(order).toEqual(["first", "second", "third", "global"]);
  expect(tryAcquireSlots(2)).toBe(true);
  releaseSlots(2);
});

it("outer completion retains an active borrower's slot and expires its unused ticket", async () => {
  const { withTransactionSlot } = await import("./lock-slots");
  const entered = gate();
  const release = gate();
  const delayed = gate();
  let borrower!: Promise<void>;
  let descendant!: Promise<void>;
  let ran = false;
  await withLockSlot(
    async () => {
      borrower = withLockSlot(async () => {
        descendant = delayed.opened.then(() =>
          withTransactionSlot(async () => {
            ran = true;
          }),
        );
        entered.open();
        await release.opened;
      });
      await entered.opened;
    },
    { nested: 1 },
  );
  try {
    // Only the outer slot returned. The detached borrower is still using the other.
    expect(tryAcquireSlots(2)).toBe(false);
    expect(tryAcquireSlots()).toBe(true);
    delayed.open();
    await Promise.resolve();
    await Promise.resolve();
    expect(ran).toBe(false);
    releaseSlots();
    await descendant;
    expect(ran).toBe(true);
  } finally {
    release.open();
    await borrower;
  }
  expect(tryAcquireSlots(2)).toBe(true);
  releaseSlots(2);
});

it("reservation-local deadline cancellation removes the head and wakes the next child", async () => {
  configureLockSlots(4);
  try {
    await withLockSlot(
      async () => {
        const release = gate();
        const entered = gate();
        const borrower = withLockSlot(async () => {
          entered.open();
          await release.opened;
        });
        await entered.opened;
        const pair = withLockSlot(async () => "pair", {
          nested: 1,
          deadline: performance.now() + 30,
        });
        const single = withLockSlot(async () => "single");
        try {
          await expect(pair).rejects.toBeInstanceOf(LockSlotTimeoutError);
          await expect(single).resolves.toBe("single");
        } finally {
          release.open();
          await borrower;
        }
      },
      { nested: 2 },
    );
    expect(tryAcquireSlots(3)).toBe(true);
    releaseSlots(3);
  } finally {
    configureLockSlots(3);
  }
});

it.each([false, true])(
  "closing a reservation moves queued children globally (deadline=%s)",
  async (expires) => {
    const entered = gate();
    const release = gate();
    let borrower!: Promise<void>;
    let queued!: Promise<void>;
    let ran = false;
    // A global pair already ahead of the promoted child must keep its place.
    const outerIn = gate();
    const exit = gate();
    const outer = withLockSlot(
      async () => {
        borrower = withLockSlot(async () => {
          entered.open();
          await release.opened;
        });
        await entered.opened;
        queued = withLockSlot(
          async () => {
            ran = true;
          },
          {
            deadline: performance.now() + (expires ? 30 : 1_000),
          },
        );
        // Attach before the deadline to avoid an unhandled rejection.
        void queued.catch(() => {});
        outerIn.open();
        await exit.opened;
      },
      { nested: 1 },
    );
    await outerIn.opened;
    const pairIn = gate();
    const pairRelease = gate();
    const pair = withLockSlot(
      async () => {
        pairIn.open();
        await pairRelease.opened;
      },
      { nested: 1 },
    );
    exit.open();
    await outer;
    try {
      expect(ran).toBe(false);
      if (expires) await expect(queued).rejects.toBeInstanceOf(LockSlotTimeoutError);
      release.open();
      await borrower;
      await pairIn.opened;
      expect(ran).toBe(false);
    } finally {
      release.open();
      pairRelease.open();
      await Promise.all([borrower, pair]);
    }
    if (!expires) await queued;
    expect(ran).toBe(!expires);
    expect(tryAcquireSlots(2)).toBe(true);
    releaseSlots(2);
  },
);

it("refuses a nested reservation that cannot fit instead of waiting behind itself", async () => {
  await withLockSlot(
    async () => {
      await expect(withLockSlot(async () => {}, { nested: 1 })).rejects.toBeInstanceOf(RangeError);
      await expect(
        withLockSlot(async () => {}, { deadline: performance.now() - 1 }),
      ).rejects.toBeInstanceOf(LockSlotTimeoutError);
      await withLockSlot(async () => {});
    },
    { nested: 1 },
  );
  expect(tryAcquireSlots(2)).toBe(true);
  releaseSlots(2);
});

it("a transaction ticket prepays exactly one raw transaction", async () => {
  const { withTransactionSlot } = await import("./lock-slots");
  await withLockSlot(
    async () => {
      await withTransactionSlot(async () => {});
      await withTransactionSlot(async () => {});
    },
    { nested: 1 },
  );
  expect(tryAcquireSlots(2)).toBe(true);
  releaseSlots(2);
});

it("retains nested borrowers through ancestor rejection until each actually finishes", async () => {
  configureLockSlots(4);
  const childEntered = gate();
  const grandchildEntered = gate();
  const releaseChild = gate();
  const releaseGrandchild = gate();
  let child!: Promise<void>;
  let grandchild!: Promise<void>;
  try {
    await expect(
      withLockSlot(
        async () => {
          child = withLockSlot(
            async () => {
              grandchild = withLockSlot(async () => {
                grandchildEntered.open();
                await releaseGrandchild.opened;
              });
              await grandchildEntered.opened;
              childEntered.open();
              await releaseChild.opened;
            },
            { nested: 1 },
          );
          await childEntered.opened;
          throw new Error("outer failed");
        },
        { nested: 2 },
      ),
    ).rejects.toThrow("outer failed");
    expect(tryAcquireSlots(2)).toBe(false);
    expect(tryAcquireSlots()).toBe(true);
    releaseSlots();
    releaseChild.open();
    await child;
    // Child's own slot returned, but the grandchild is still charged.
    expect(tryAcquireSlots(3)).toBe(false);
    expect(tryAcquireSlots(2)).toBe(true);
    releaseSlots(2);
  } finally {
    releaseChild.open();
    releaseGrandchild.open();
    await Promise.all([child, grandchild]);
    configureLockSlots(3);
  }
  expect(tryAcquireSlots(2)).toBe(true);
  releaseSlots(2);
});

it("a closing borrower wakes promoted children even when its parent keeps the returned slot", async () => {
  configureLockSlots(5);
  const entered = gate();
  const release = gate();
  let active!: Promise<void>;
  let queued!: Promise<string>;
  try {
    await withLockSlot(
      async () => {
        await withLockSlot(
          async () => {
            active = withLockSlot(async () => {
              entered.open();
              await release.opened;
            });
            await entered.opened;
            queued = withLockSlot(async () => "promoted", {
              deadline: performance.now() + 1_000,
            });
          },
          { nested: 1 },
        );
        try {
          // Parent retains the returned slot, but the fourth global slot is free.
          await expect(queued).resolves.toBe("promoted");
        } finally {
          release.open();
          await active;
        }
      },
      { nested: 2 },
    );
    expect(tryAcquireSlots(4)).toBe(true);
    releaseSlots(4);
  } finally {
    release.open();
    await active;
    configureLockSlots(3);
  }
});

it("refunds idle spares when a queued child resumes admission after its parent exits", async () => {
  configureLockSlots(4);
  const releaseParent = gate();
  const releaseA = gate();
  const releaseB = gate();
  const bEntered = gate();
  const releaseGlobal = gate();
  let active = 0;
  let childA!: Promise<void>;
  let childB!: Promise<void>;
  let global: Promise<void> | undefined;
  let globalStarted = false;
  const parent = withLockSlot(
    () => {
      active++;
      childA = withLockSlot(
        () => {
          active++;
          return releaseA.opened;
        },
        { nested: 1 },
      );
      childB = withLockSlot(
        async () => {
          active++;
          bEntered.open();
          try {
            await releaseB.opened;
          } finally {
            active--;
          }
        },
        { nested: 1 },
      );
      return releaseParent.opened;
    },
    { nested: 2 },
  );
  try {
    expect(active).toBe(2);
    // A and P must return the deferred promises directly: async/await wrappers
    // change the cleanup ordering that admits B before its parent invalidates.
    active -= 2;
    releaseA.open();
    releaseParent.open();
    await Promise.all([parent, childA, bEntered.opened]);
    expect(active).toBe(1);

    global = withLockSlot(
      async () => {
        active++;
        globalStarted = true;
        try {
          await releaseGlobal.opened;
        } finally {
          active--;
        }
      },
      { nested: 1 },
    );
    // B's unusable spare must already be available to unrelated work.
    expect(globalStarted).toBe(true);
    expect(active).toBe(2);
    // B's own slot stays charged alongside the global pair: no fourth slot.
    const extra = tryAcquireSlots();
    if (extra) releaseSlots();
    expect(extra).toBe(false);
  } finally {
    releaseA.open();
    releaseParent.open();
    releaseB.open();
    releaseGlobal.open();
    await Promise.all([parent, childA, childB, global]);
    configureLockSlots(3);
  }
  expect(active).toBe(0);
  expect(tryAcquireSlots(2)).toBe(true);
  releaseSlots(2);
});

it.each(["unused", "returned"] as const)(
  "ancestor close releases a still-active child's %s spare",
  async (kind) => {
    configureLockSlots(4);
    const entered = gate();
    const releaseChild = gate();
    const releaseGrandchild = gate();
    let child!: Promise<void>;
    let grandchild: Promise<void> | undefined;
    try {
      await withLockSlot(
        async () => {
          child = withLockSlot(
            async () => {
              if (kind === "returned") {
                const borrowed = gate();
                grandchild = withLockSlot(async () => {
                  borrowed.open();
                  await releaseGrandchild.opened;
                });
                await borrowed.opened;
              }
              entered.open();
              await releaseChild.opened;
            },
            { nested: 1 },
          );
          await entered.opened;
        },
        { nested: 2 },
      );
      if (grandchild) {
        expect(tryAcquireSlots(2)).toBe(false);
        releaseGrandchild.open();
        await grandchild;
      }
      // Only the active child's own transaction is charged. Its invalid
      // reservation cannot use this spare, so global admission must be able to.
      const available = tryAcquireSlots(2);
      if (available) releaseSlots(2);
      expect(available).toBe(true);
    } finally {
      releaseGrandchild.open();
      releaseChild.open();
      await Promise.all([child, grandchild]);
      configureLockSlots(3);
    }
    expect(tryAcquireSlots(2)).toBe(true);
    releaseSlots(2);
  },
);
