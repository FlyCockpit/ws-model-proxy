import { describe, expect, it } from "vitest";

import {
  pickerLabels,
  terminalInputIcon,
  terminalModeKeys,
  terminalNoticeKey,
  terminalNoticeNeeded,
  terminalTone,
} from "@/lib/terminal-header";
import type { TabStatus } from "@/lib/terminal-tab-status";

const LIVE: TabStatus = { phase: "live", inputDropped: false };
const OPENING: TabStatus = { phase: "opening", approvalCode: null, reopen: null };
const REFUSED: TabStatus = { phase: "rejected", reason: "offline" };
const ENDED: TabStatus = { phase: "exited", cause: "exit", exitCode: 0, exitSignal: null };

describe("terminalInputIcon", () => {
  it("is an eye only while another viewer holds the input", () => {
    expect(terminalInputIcon({ status: LIVE, writer: "you" })).toBe("keyboard");
    expect(terminalInputIcon({ status: LIVE, writer: "none" })).toBe("keyboard");
    expect(terminalInputIcon({ status: LIVE, writer: "other" })).toBe("eye");
  });
});

describe("terminalTone", () => {
  it("colors by the connection state", () => {
    expect(terminalTone(LIVE)).toBe("live");
    expect(terminalTone(OPENING)).toBe("opening");
    expect(terminalTone(REFUSED)).toBe("rejected");
    expect(terminalTone(ENDED)).toBe("exited");
    expect(terminalTone({ phase: "exited", cause: "gone" })).toBe("exited");
  });
});

describe("terminalModeKeys", () => {
  it("says typing or viewing only while connected", () => {
    expect(terminalModeKeys({ status: LIVE, writer: "you" })).toEqual({
      phase: "terminals:phase.live",
      mode: "terminals:header.typing",
    });
    expect(terminalModeKeys({ status: LIVE, writer: "other" })).toEqual({
      phase: "terminals:phase.live",
      mode: "terminals:header.viewing",
    });
    expect(terminalModeKeys({ status: ENDED, writer: "other" })).toEqual({
      phase: "terminals:phase.exited",
      mode: null,
    });
    expect(terminalModeKeys({ status: OPENING, writer: "none" }).mode).toBeNull();
  });
});

describe("pickerLabels", () => {
  it("numbers tabs on the same node, in tab order", () => {
    const tabs = [{ n: "hermes" }, { n: "mini" }, { n: "hermes" }];
    const labels = pickerLabels(tabs, (tab) => tab.n);
    expect(tabs.map((tab) => labels.get(tab))).toEqual(["hermes (1)", "mini", "hermes (2)"]);
  });
});

describe("terminalNoticeNeeded", () => {
  it("keeps what must be said and drops who is typing", () => {
    expect(terminalNoticeNeeded({ status: LIVE, ending: null })).toBe(false);
    expect(terminalNoticeNeeded({ status: OPENING, ending: null })).toBe(false);
    // End session refused while the tab reattaches: still said.
    expect(terminalNoticeNeeded({ status: OPENING, ending: "failed" })).toBe(true);
    expect(
      terminalNoticeNeeded({
        status: { phase: "opening", approvalCode: null, reopen: "detached" },
        ending: "failed",
      }),
    ).toBe(true);
    expect(terminalNoticeNeeded({ status: LIVE, ending: "pending" })).toBe(false);
    expect(terminalNoticeNeeded({ status: LIVE, ending: "failed" })).toBe(true);
    expect(
      terminalNoticeNeeded({ status: { phase: "live", inputDropped: true }, ending: null }),
    ).toBe(true);
    expect(
      terminalNoticeNeeded({
        status: { phase: "opening", approvalCode: "ABCD", reopen: null },
        ending: null,
      }),
    ).toBe(true);
    expect(terminalNoticeNeeded({ status: REFUSED, ending: null })).toBe(true);
    expect(terminalNoticeNeeded({ status: ENDED, ending: null })).toBe(true);
  });
});

describe("terminalNoticeKey", () => {
  it("changes when the notice has something else to say", () => {
    const key = (status: TabStatus, ending: "pending" | "failed" | null = null) =>
      terminalNoticeKey({ localId: "a", status, ending });
    expect(key(REFUSED)).not.toBe(key({ phase: "rejected", reason: "not_granted" }));
    expect(key(LIVE, "failed")).not.toBe(key(LIVE));
    expect(key(OPENING, "failed")).not.toBe(key(OPENING));
    expect(key({ phase: "live", inputDropped: true })).not.toBe(key(LIVE));
    expect(key(ENDED)).not.toBe(key({ phase: "exited", cause: "gone" }));
    expect(terminalNoticeKey({ localId: "b", status: REFUSED, ending: null })).not.toBe(
      key(REFUSED),
    );
  });
});
