import { describe, expect, it } from "vitest";
import { createAdminMailBudget } from "./admin-mail-budget";

describe("admin mail procedure budgets", () => {
  it("shares 30/hour per admin across invite and resend", () => {
    const budget = createAdminMailBudget();
    for (let i = 0; i < 30; i++) budget.charge("admin", i % 2 ? `target-${i}` : undefined);
    expect(() => budget.charge("admin")).toThrow(/Too many/);
    expect(() => budget.charge("other")).not.toThrow();
  });
  it("limits each resend target to five across admins and fails closed atomically", () => {
    const budget = createAdminMailBudget();
    for (let i = 0; i < 5; i++) budget.charge(`admin-${i}`, "target");
    expect(() => budget.charge("new", "target")).toThrow(/Too many/);
    for (let i = 0; i < 30; i++) budget.charge("new");
  });
  it("bounds memory, expires entries, and refuses an unavailable clock", () => {
    let time = 0;
    const budget = createAdminMailBudget({ maxEntries: 2, now: () => time });
    budget.charge("a", "target");
    expect(() => budget.charge("b")).toThrow(/Too many/);
    time = 3_600_000;
    expect(() => budget.charge("b")).not.toThrow();
    time = Number.NaN;
    expect(() => budget.charge("b")).toThrow(/Too many/);
  });
});
