// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { claimTouchMouse } from "./terminal-touch-mouse";

/**
 * The document owner of a touch's mouse events, with stand-in panes. Each test has its own
 * document, so the owner's per-document record starts empty.
 */

const releases: (() => void)[] = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
});

type Kind = "touch" | "mouse" | "pen" | "none";

function page() {
  const doc = document.implementation.createHTMLDocument();
  /** Every acting event that reached the document's bubble phase (xterm's document listeners). */
  const atDocument = new Map<Event, string>();
  for (const type of [
    "mousemove",
    "mousedown",
    "mouseup",
    "click",
    "auxclick",
    "dblclick",
    "contextmenu",
  ])
    doc.addEventListener(type, (event) => atDocument.set(event, (event.target as Element).id));
  const outside = doc.body.appendChild(doc.createElement("button"));
  outside.id = "outside";
  /**
   * A pane whose release decision grants what `state.granted` says. `tap()` is a new tap (a new
   * grant), `end()` an end of its interaction (no grant).
   */
  const pane = (id: string, granted = false) => {
    const container = doc.body.appendChild(doc.createElement("div"));
    container.id = id;
    const inner = container.appendChild(doc.createElement("div"));
    inner.id = `${id}-xterm`;
    const state = { granted, token: {} };
    const claim = claimTouchMouse(container, {
      grant: () => (state.granted ? state.token : null),
    });
    releases.push(claim.release);
    const tap = () => {
      state.granted = true;
      state.token = {};
    };
    const end = () => {
      state.granted = false;
    };
    return {
      container,
      inner,
      state,
      tap,
      end,
      release: claim.release,
      foreignRelease: claim.foreignRelease,
    };
  };
  /** A new finger anywhere on the page: its touchstart, as the document's capture sees it. */
  const touchStart = (target: EventTarget = outside) =>
    target.dispatchEvent(new Event("touchstart", { bubbles: true, cancelable: true }));
  /**
   * For each mouseup that reaches the document after the owner (as xterm's document listener
   * does, added at a press), the panes whose terminal must send nothing for it.
   */
  const foreign = new Map<Event, string[]>();
  const watchForeign = (
    ...panes: { container: HTMLElement; foreignRelease: (e: Event) => boolean }[]
  ) =>
    doc.addEventListener("mouseup", (event) =>
      foreign.set(
        event,
        panes.filter((one) => one.foreignRelease(event)).map((one) => one.container.id),
      ),
    );
  /**
   * A mouse event as an engine makes it. `kind` is Chromium's `sourceCapabilities.firesTouchEvents`
   * (touch: true, mouse or pen: false); "none" leaves it out (WebKit, Firefox).
   */
  const mouse = (target: EventTarget, type: string, kind: Kind, init: MouseEventInit = {}) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      detail: type === "click" || type === "dblclick" ? 1 : 0,
      buttons: type === "mousedown" ? 1 : 0,
      ...init,
    });
    if (kind !== "none")
      Object.defineProperty(event, "sourceCapabilities", {
        value: { firesTouchEvents: kind === "touch" },
      });
    target.dispatchEvent(event);
    return event;
  };
  const pointer = (target: EventTarget, type: string, pointerType: string, pointerId = 1) => {
    const event = new PointerEvent(type, {
      pointerType,
      pointerId,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(event);
    return event;
  };
  /** Whether an event acted: it reached the document's listeners and was not cancelled. */
  const acted = (event: Event, target: string) =>
    atDocument.get(event) === target && !event.defaultPrevented;
  return {
    doc,
    outside,
    pane,
    mouse,
    pointer,
    atDocument,
    acted,
    touchStart,
    foreign,
    watchForeign,
  };
}

describe("routing: a touch's mouse event acts only in the pane that tapped", () => {
  it("lets it through in the pane with a grant, holds it back in a pane without", () => {
    const p = page();
    const a = p.pane("a", true);
    const b = p.pane("b", false);
    for (const type of [
      "mousemove",
      "mousedown",
      "mouseup",
      "click",
      "auxclick",
      "dblclick",
      "contextmenu",
    ]) {
      expect(p.acted(p.mouse(a.inner, type, "touch"), "a-xterm")).toBe(true);
      const held = p.mouse(b.inner, type, "touch");
      expect(p.acted(held, "b-xterm")).toBe(false);
      expect(held.defaultPrevented).toBe(true);
    }
  });

  it("leaves a touch on the page outside the panes alone, when no press is in progress", () => {
    const p = page();
    p.pane("a");
    for (const type of [
      "mousemove",
      "mousedown",
      "mouseup",
      "click",
      "auxclick",
      "dblclick",
      "contextmenu",
    ])
      expect(p.acted(p.mouse(p.outside, type, "touch"), "outside")).toBe(true);
  });

  it("never holds back a mouse's or a pen's events", () => {
    const p = page();
    p.pane("a", false);
    for (const type of ["mousemove", "mousedown", "mouseup", "click", "auxclick"])
      for (const kind of ["mouse", "pen", "none"] as const)
        expect(p.acted(p.mouse(p.doc.getElementById("a-xterm")!, type, kind), "a-xterm")).toBe(
          true,
        );
  });

  it("holds back a touch's middle auxclick in a pane without a grant, not a mouse's (R7-B-1)", () => {
    const p = page();
    const a = p.pane("a", false);
    const touch = p.mouse(a.inner, "auxclick", "touch", { button: 1 });
    expect(p.acted(touch, "a-xterm")).toBe(false);
    expect(touch.defaultPrevented).toBe(true);
    for (const kind of ["mouse", "none"] as const)
      expect(p.acted(p.mouse(a.inner, "auxclick", kind, { button: 1 }), "a-xterm")).toBe(true);
    // Under the same rules as a click: with the pane's tap, a touch's auxclick acts too.
    a.tap();
    expect(p.acted(p.mouse(a.inner, "auxclick", "touch", { button: 1 }), "a-xterm")).toBe(true);
  });
});

describe("a real press in progress", () => {
  it("holds back a touch's mouseup and mousemove anywhere, and every touch event in a pane", () => {
    const p = page();
    const a = p.pane("a", false);
    const b = p.pane("b", true);
    p.mouse(a.inner, "mousedown", "mouse");
    for (const type of ["mousemove", "mouseup"]) {
      const event = p.mouse(p.outside, type, "touch");
      expect(p.acted(event, "outside")).toBe(false);
      // Nothing to cancel: the page's own UI keeps its click.
      expect(event.defaultPrevented).toBe(false);
    }
    for (const type of ["mousedown", "click", "auxclick", "dblclick", "contextmenu"])
      expect(p.acted(p.mouse(p.outside, type, "touch"), "outside")).toBe(true);
    // Even the pane that tapped: its press would be ended by the mouse's release.
    for (const type of ["mousemove", "mousedown", "mouseup", "click", "auxclick"])
      expect(p.acted(p.mouse(b.inner, type, "touch"), "b-xterm")).toBe(false);
    // The mouse's own drag and release outside the pane are untouched (a desktop drag).
    expect(p.acted(p.mouse(p.outside, "mousemove", "mouse", { buttons: 1 }), "outside")).toBe(true);
    expect(p.acted(p.mouse(p.outside, "mouseup", "mouse"), "outside")).toBe(true);
    // Released: a touch acts again where it was granted, and outside.
    for (const type of ["mousemove", "mousedown", "mouseup", "click", "auxclick"])
      expect(p.acted(p.mouse(b.inner, type, "touch"), "b-xterm")).toBe(true);
    expect(p.acted(p.mouse(p.outside, "mouseup", "touch"), "outside")).toBe(true);
  });

  it("lasts while a button is still down, and while the release never reached the document", () => {
    const p = page();
    const a = p.pane("a");
    p.mouse(a.inner, "mousedown", "mouse");
    // Another button is still held: xterm keeps listening.
    p.mouse(p.outside, "mouseup", "mouse", { buttons: 2 });
    expect(p.acted(p.mouse(p.outside, "mouseup", "touch"), "outside")).toBe(false);
    // A release whose propagation the page stopped never reached xterm's document listeners.
    const stopper = (event: Event) => event.stopPropagation();
    p.outside.addEventListener("mouseup", stopper);
    p.mouse(p.outside, "mouseup", "mouse");
    p.outside.removeEventListener("mouseup", stopper);
    expect(p.acted(p.mouse(p.outside, "mouseup", "touch"), "outside")).toBe(false);
    // A touch's mouseup reaching the document never ends it either: it is held back.
    p.mouse(p.outside, "mouseup", "mouse");
    expect(p.acted(p.mouse(p.outside, "mouseup", "touch"), "outside")).toBe(true);
  });

  it("is not ended by a blur; it is ended when its pane goes away", () => {
    const p = page();
    const a = p.pane("a");
    p.pane("b");
    p.mouse(a.inner, "mousedown", "mouse");
    // (This document has no window; the real-xterm A-DOCUMENT test blurs the page's window.)
    p.doc.defaultView?.dispatchEvent(new Event("blur"));
    expect(p.acted(p.mouse(p.outside, "mouseup", "touch"), "outside")).toBe(false);
    a.release();
    expect(p.acted(p.mouse(p.outside, "mouseup", "touch"), "outside")).toBe(true);
  });
});

describe("which device made a mouse event: the event's own data only", () => {
  it("takes Chromium's sourceCapabilities first; null (a script's event) is no touch's", () => {
    const p = page();
    const a = p.pane("a", false);
    expect(p.acted(p.mouse(a.inner, "mousedown", "touch"), "a-xterm")).toBe(false);
    expect(p.acted(p.mouse(a.inner, "mousedown", "mouse"), "a-xterm")).toBe(true);
    const scripted = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    Object.defineProperty(scripted, "sourceCapabilities", { value: null });
    a.inner.dispatchEvent(scripted);
    expect(p.acted(scripted, "a-xterm")).toBe(true);
    // Capabilities outrank a PointerEvent's own pointer type.
    const contradictory = new PointerEvent("click", {
      pointerType: "mouse",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(contradictory, "sourceCapabilities", {
      value: { firesTouchEvents: true },
    });
    a.inner.dispatchEvent(contradictory);
    expect(p.acted(contradictory, "a-xterm")).toBe(false);
  });

  it("takes a click, auxclick or contextmenu PointerEvent by its own pointer type", () => {
    const p = page();
    const a = p.pane("a", false);
    for (const type of ["click", "auxclick", "contextmenu"])
      for (const [pointerType, acts] of [
        ["touch", false],
        ["mouse", true],
        ["pen", true],
      ] as const) {
        const event = new PointerEvent(type, { pointerType, bubbles: true, cancelable: true });
        a.inner.dispatchEvent(event);
        expect(p.acted(event, "a-xterm")).toBe(acts);
      }
  });

  it("takes a keyboard's context menu and click as no touch's (pointerId -1, no pointer type)", () => {
    const p = page();
    const a = p.pane("a", false);
    p.pointer(a.inner, "pointerdown", "touch", 2);
    for (const type of ["contextmenu", "click"]) {
      const event = new PointerEvent(type, {
        pointerId: -1,
        pointerType: "",
        bubbles: true,
        cancelable: true,
      });
      a.inner.dispatchEvent(event);
      expect(p.acted(event, "a-xterm")).toBe(true);
    }
  });

  it("takes a plain mouse event (no capabilities, no pointer type) as a mouse's, whatever came before", () => {
    const p = page();
    const a = p.pane("a", false);
    // A touch is down, another was just lifted, a mouse moved: none of it is read.
    p.pointer(p.outside, "pointerdown", "touch", 2);
    p.pointer(a.inner, "pointerup", "touch", 3);
    p.pointer(p.outside, "pointermove", "mouse");
    for (const type of ["mousemove", "mousedown", "mouseup", "click", "dblclick", "contextmenu"])
      expect(p.acted(p.mouse(a.inner, type, "none", { detail: 1 }), "a-xterm")).toBe(true);
  });

  it("installs no pointer listeners: there is no pointer state to keep", () => {
    const p = page();
    const add = vi.spyOn(p.doc, "addEventListener");
    p.pane("a");
    expect(
      add.mock.calls.map(([type]) => type).filter((type) => type.startsWith("pointer")),
    ).toEqual([]);
  });

  it.each(["mouse", "pen"] as const)(
    "keeps every button of a %s chord after a touch (R6-A-1), with and without capabilities",
    (pointerType) => {
      for (const kind of [pointerType === "pen" ? "pen" : "mouse", "none"] as const) {
        const p = page();
        const a = p.pane("a", true);
        // A tap's own sequence first.
        for (const type of ["mousemove", "mousedown", "mouseup", "click"])
          expect(p.acted(p.mouse(a.inner, type, "touch"), "a-xterm")).toBe(true);
        a.end();
        // The chord: the first button's down, the second's down and up (announced to pointer
        // listeners by pointermove only), the first's up, released outside the pane.
        p.pointer(a.inner, "pointerdown", pointerType);
        const events = [
          p.mouse(a.inner, "mousedown", kind, { button: 0, buttons: 1 }),
          p.mouse(a.inner, "mousedown", kind, { button: 2, buttons: 3 }),
          p.mouse(p.outside, "mouseup", kind, { button: 2, buttons: 1 }),
          p.mouse(p.outside, "mouseup", kind, { button: 0, buttons: 0 }),
        ];
        expect(events.map((event) => !event.defaultPrevented && p.atDocument.has(event))).toEqual([
          true,
          true,
          true,
          true,
        ]);
      }
    },
  );
});

describe("a press xterm took from a touch (a tap's own mousedown)", () => {
  it("lets that tap's own release and drag act anywhere, and ends with its release", () => {
    const p = page();
    const a = p.pane("a", true);
    expect(p.acted(p.mouse(a.inner, "mousedown", "touch"), "a-xterm")).toBe(true);
    // Its own drag and release, also outside the pane (still this tap's grant).
    expect(p.acted(p.mouse(p.outside, "mousemove", "touch", { buttons: 1 }), "outside")).toBe(true);
    expect(p.acted(p.mouse(p.outside, "mouseup", "touch"), "outside")).toBe(true);
    // Ended: a touch outside acts as on any page, and a new tap of a's own acts in a.
    a.end();
    for (const type of ["mousemove", "mouseup"])
      expect(p.acted(p.mouse(p.outside, type, "touch"), "outside")).toBe(true);
    a.tap();
    for (const type of ["mousemove", "mousedown", "mouseup", "click"])
      expect(p.acted(p.mouse(a.inner, type, "touch"), "a-xterm")).toBe(true);
  });

  // Round 9 (F-FB-1): a tap's press never outlives its own touch, or every touch was held back
  // until a remount. Its release is its own by the press alone (no other touch can make a mouseup
  // before the next touchstart), not by its grant still being current.
  it("lets its own release act after its grant ended (time, an interaction end), and ends there", () => {
    const p = page();
    const a = p.pane("a", true);
    const b = p.pane("b", false);
    p.mouse(a.inner, "mousedown", "touch");
    // A reset, retire, attach, disable, hidden page, or its 1 s window: the pane's grant is gone.
    a.end();
    // Its drag is no longer its own; its release still is.
    expect(p.acted(p.mouse(p.outside, "mousemove", "touch", { buttons: 1 }), "outside")).toBe(
      false,
    );
    expect(p.acted(p.mouse(a.inner, "mouseup", "touch"), "a-xterm")).toBe(true);
    // Ended: nothing is held back for it, and taps act where they are granted.
    for (const type of ["mousemove", "mouseup"])
      expect(p.acted(p.mouse(p.outside, type, "touch"), "outside")).toBe(true);
    b.tap();
    for (const type of ["mousemove", "mousedown", "mouseup", "click"])
      expect(p.acted(p.mouse(b.inner, type, "touch"), "b-xterm")).toBe(true);
  });

  it("lets its own release act where the browser re-aimed it (another pane), and ends there (T24)", () => {
    const p = page();
    const a = p.pane("a", true);
    const b = p.pane("b", false);
    p.watchForeign(a, b);
    p.mouse(a.inner, "mousedown", "touch");
    const up = p.mouse(b.inner, "mouseup", "touch");
    expect(p.acted(up, "b-xterm")).toBe(true);
    // a's terminal sends its release: it is the press's own.
    expect(p.foreign.get(up)).toEqual([]);
    // Its click, re-aimed outside: the page's.
    expect(p.acted(p.mouse(p.outside, "click", "touch"), "outside")).toBe(true);
    // Nothing is held back afterwards: a new tap in either pane acts.
    for (const pane of [a, b]) {
      p.touchStart();
      pane.tap();
      for (const type of ["mousedown", "mouseup", "click"])
        expect(p.acted(p.mouse(pane.inner, type, "touch"), pane.inner.id)).toBe(true);
    }
  });

  it("ends at a release the page stops before the document; the next touch's release is not its own", () => {
    const p = page();
    const a = p.pane("a", true);
    const b = p.pane("b", false);
    p.watchForeign(a, b);
    p.mouse(a.inner, "mousedown", "touch");
    // Its release never reached the document (the page stopped it): a's terminal still waits.
    const stopper = (event: Event) => event.stopPropagation();
    a.inner.addEventListener("mouseup", stopper);
    const up = p.mouse(a.inner, "mouseup", "touch");
    a.inner.removeEventListener("mouseup", stopper);
    expect(up.defaultPrevented).toBe(false);
    // Another touch: b taps, and acts (nothing held back any more).
    a.end();
    p.touchStart();
    b.tap();
    for (const type of ["mousemove", "mousedown"])
      expect(p.acted(p.mouse(b.inner, type, "touch"), "b-xterm")).toBe(true);
    const bUp = p.mouse(b.inner, "mouseup", "touch");
    expect(p.acted(bUp, "b-xterm")).toBe(true);
    // a's terminal answers it with the old press's release: that is not this touch's to send.
    expect(p.foreign.get(bUp)).toEqual(["a"]);
    expect(p.acted(p.mouse(b.inner, "click", "touch"), "b-xterm")).toBe(true);
    // That release reached the document, so a's terminal stopped waiting: the next one is no one's.
    p.touchStart();
    const outsideUp = p.mouse(p.outside, "mouseup", "touch");
    expect(p.acted(outsideUp, "outside")).toBe(true);
    expect(p.foreign.get(outsideUp)).toEqual([]);
  });

  it("ends at the next touchstart when its release never came; that touch's release is not its own", () => {
    const p = page();
    const a = p.pane("a", true);
    p.watchForeign(a);
    p.mouse(a.inner, "mousedown", "touch");
    // Its drag acts while its grant is current; after that a touch's mousemove is held back
    // until the press ends.
    expect(p.acted(p.mouse(p.outside, "mousemove", "touch"), "outside")).toBe(true);
    a.end();
    expect(p.acted(p.mouse(p.outside, "mousemove", "touch"), "outside")).toBe(false);
    p.touchStart();
    expect(p.acted(p.mouse(p.outside, "mousemove", "touch"), "outside")).toBe(true);
    const up = p.mouse(p.outside, "mouseup", "touch");
    expect(p.acted(up, "outside")).toBe(true);
    expect(p.foreign.get(up)).toEqual(["a"]);
    a.tap();
    for (const type of ["mousedown", "mouseup", "click"])
      expect(p.acted(p.mouse(a.inner, type, "touch"), "a-xterm")).toBe(true);
  });

  it("a new press in the pane is not stale: its own release goes out", () => {
    const p = page();
    const a = p.pane("a", true);
    p.watchForeign(a);
    p.mouse(a.inner, "mousedown", "touch");
    p.touchStart();
    a.tap();
    p.mouse(a.inner, "mousedown", "touch");
    const up = p.mouse(a.inner, "mouseup", "touch");
    expect(p.acted(up, "a-xterm")).toBe(true);
    expect(p.foreign.get(up)).toEqual([]);
  });

  it("a mouse's release reaching the document is never foreign (the old press's release goes out)", () => {
    const p = page();
    const a = p.pane("a", true);
    p.watchForeign(a);
    p.mouse(a.inner, "mousedown", "touch");
    p.touchStart();
    const up = p.mouse(p.outside, "mouseup", "mouse");
    expect(p.foreign.get(up)).toEqual([]);
    // It reached the document: the next touch's release is no one's either.
    const touchUp = p.mouse(p.outside, "mouseup", "touch");
    expect(p.foreign.get(touchUp)).toEqual([]);
  });

  it("ends when its pane goes away", () => {
    const p = page();
    const a = p.pane("a", true);
    p.pane("b");
    p.mouse(a.inner, "mousedown", "touch");
    a.end();
    expect(p.acted(p.mouse(p.outside, "mousemove", "touch"), "outside")).toBe(false);
    a.release();
    expect(p.acted(p.mouse(p.outside, "mousemove", "touch"), "outside")).toBe(true);
  });

  it("is held back while a mouse press began meanwhile, and ends there; the mouse's release ends both", () => {
    const p = page();
    const a = p.pane("a", true);
    const b = p.pane("b");
    p.watchForeign(a, b);
    p.mouse(a.inner, "mousedown", "touch");
    p.mouse(b.inner, "mousedown", "mouse");
    // A mouse press is in progress: no touch may end it (its release would reach b's terminal).
    expect(p.acted(p.mouse(a.inner, "mouseup", "touch"), "a-xterm")).toBe(false);
    // The mouse's release reaches every terminal: a's sends its old press's release too.
    const up = p.mouse(p.outside, "mouseup", "mouse");
    expect(p.foreign.get(up)).toEqual([]);
    a.end();
    expect(p.acted(p.mouse(p.outside, "mouseup", "touch"), "outside")).toBe(true);
  });
});

describe("one owner per document", () => {
  it("installs its listeners once for any number of panes, and removes them with the last", () => {
    const p = page();
    const add = vi.spyOn(p.doc, "addEventListener");
    const remove = vi.spyOn(p.doc, "removeEventListener");
    const a = p.pane("a");
    const b = p.pane("b");
    // StrictMode runs an effect twice: claim, release, claim.
    const c = p.pane("c");
    c.release();
    p.pane("c");
    const installed = add.mock.calls.length;
    expect(installed).toBe(7 + 1 + 1);
    a.release();
    b.release();
    expect(remove).not.toHaveBeenCalled();
    for (const release of releases.splice(0)) release();
    expect(remove.mock.calls.map(([type, , options]) => [type, options])).toEqual(
      add.mock.calls.map(([type, , options]) => [
        type,
        typeof options === "object" ? { capture: options.capture } : options,
      ]),
    );
    // Gone: nothing is held back any more.
    expect(
      p.acted(p.mouse(p.doc.getElementById("a-xterm")!, "mousedown", "touch"), "a-xterm"),
    ).toBe(true);
  });
});
