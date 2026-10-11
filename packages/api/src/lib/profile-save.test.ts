import { describe, expect, it } from "vitest";
import { planProfileSave } from "./profile-save";

const line = (nodeId: string, note: string | null = null) => ({ nodeId, note });

describe("planProfileSave", () => {
  it("keeps the stored lines when the save sends none", () => {
    expect(
      planProfileSave({
        caller: "agent",
        before: [line("a", "games")],
        after: { nodeIds: ["a", "b"], holds: undefined },
      }),
    ).toEqual({ ok: true, holds: [line("a", "games")] });
  });

  it.each([
    ["adds a line", [], [line("a")]],
    ["removes a line", [line("a")], []],
    ["changes a note", [line("a", "old")], [line("a", "new")]],
    ["moves a line to another node", [line("a")], [line("b")]],
  ])("refuses an agent that %s", (_label, before, holds) => {
    expect(
      planProfileSave({ caller: "agent", before, after: { nodeIds: ["a", "b"], holds } }),
    ).toMatchObject({ ok: false, reason: "human_only" });
  });

  it("refuses an agent that drops an owned node with a hold line (lines omitted)", () => {
    expect(
      planProfileSave({
        caller: "agent",
        before: [line("a")],
        after: { nodeIds: ["b"], holds: undefined },
      }),
    ).toEqual({ ok: false, reason: "human_only", nodeIds: ["a"] });
  });

  it("refuses an agent that drops the node and repeats the line", () => {
    expect(
      planProfileSave({
        caller: "agent",
        before: [line("a")],
        after: { nodeIds: ["b"], holds: [line("a")] },
      }),
    ).toMatchObject({ ok: false, reason: "human_only" });
  });

  it("lets an agent resend the same lines in another order", () => {
    expect(
      planProfileSave({
        caller: "agent",
        before: [line("a"), line("b", "x")],
        after: { nodeIds: ["a", "b"], holds: [line("b", "x"), line("a")] },
      }),
    ).toMatchObject({ ok: true });
  });

  it("lets a person change lines and drop held nodes", () => {
    expect(
      planProfileSave({
        caller: "person",
        before: [line("a")],
        after: { nodeIds: ["b"], holds: [line("b", "n")] },
      }),
    ).toEqual({ ok: true, holds: [line("b", "n")] });
  });

  it("refuses duplicate lines and lines on nodes the profile does not own", () => {
    expect(
      planProfileSave({
        caller: "person",
        before: [],
        after: { nodeIds: ["a"], holds: [line("a"), line("a")] },
      }),
    ).toMatchObject({ ok: false, reason: "duplicate_hold" });
    expect(
      planProfileSave({
        caller: "person",
        before: [line("a")],
        after: { nodeIds: ["b"], holds: undefined },
      }),
    ).toMatchObject({ ok: false, reason: "hold_not_owned" });
  });
});
