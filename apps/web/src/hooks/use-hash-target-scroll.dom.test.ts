// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hashTargetId, revealHashTarget } from "./use-hash-target-scroll";

const scrollIntoView = vi.fn();
const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  scrollIntoView.mockReset();
  Element.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function mount(html: string) {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
}

describe("hashTargetId", () => {
  it("decodes the hash and treats an empty one as none", () => {
    expect(hashTargetId("#a%20b")).toBe("a b");
    expect(hashTargetId("plain")).toBe("plain");
    expect(hashTargetId("#bad%")).toBe("bad%");
    expect(hashTargetId("#")).toBeNull();
    expect(hashTargetId("")).toBeNull();
  });
});

describe("revealHashTarget", () => {
  it("scrolls to and focuses a focusable target that is already mounted", () => {
    mount('<input id="field" />');
    revealHashTarget("field");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(document.activeElement?.id).toBe("field");
  });

  it("scrolls to but does not focus a target that is not focusable", () => {
    mount('<section id="part"></section>');
    revealHashTarget("part");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(document.body);
  });

  it("does not scroll to a fixed-position target", () => {
    mount('<input id="fixed" style="position: fixed" />');
    revealHashTarget("fixed");
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement?.id).toBe("fixed");
  });

  it("waits for the target to mount", async () => {
    revealHashTarget("late");
    expect(scrollIntoView).not.toHaveBeenCalled();
    mount('<button id="late">Late</button>');
    await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(document.activeElement?.id).toBe("late");
  });

  it("gives up quietly after the wait", async () => {
    vi.useFakeTimers();
    revealHashTarget("never", 100);
    vi.advanceTimersByTime(101);
    vi.useRealTimers();
    mount('<div id="never"></div>');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("gives up when the person scrolls first, or when cancelled", async () => {
    revealHashTarget("a");
    window.dispatchEvent(new Event("wheel"));
    const cancel = revealHashTarget("b");
    cancel();
    mount('<div id="a"></div><div id="b"></div>');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
