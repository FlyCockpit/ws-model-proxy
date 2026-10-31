/**
 * The one place that decides whether a mouse event a touch made may act in a terminal.
 *
 * A browser follows a tap with compatibility mouse events (mousemove, mousedown, mouseup, click),
 * hit-tested at the finger. xterm acts on them in two kinds of places: listeners on its own
 * element (focus, click reports, selection, links, the context menu and Linux's middle-click
 * `auxclick` that move and focus its textarea, `armClick`'s writer claim) and listeners it adds
 * to the document after a press it accepts (the release and drag reports, and a selection's end),
 * which see a mouseup or mousemove wherever on the page it lands. A filter on a pane covers the
 * first kind only. So each document has one owner, a capture listener on the document: it runs
 * before every xterm listener of every pane, on the pane or on the document.
 *
 * - A touch's mouse event aimed at a pane acts only if that pane's own release decided `tap` for
 *   it (`grant`), and no press is in progress anywhere (or it is that press's own event).
 * - While a press is in progress (xterm's document listeners wait for its release), a touch's
 *   mouseup and mousemove are held back wherever they land, unless they are that press's own: a
 *   touch-admitted press's own release (wherever it lands, even once its grant has ended) and its
 *   drag (while its tap's grant is still current).
 * - A touch's press never outlives its own touch: it ends at the first touch mouseup with no button
 *   left that comes here (its own release, even one held back) and at the next touchstart. The
 *   browser makes a tap's mousedown, mouseup and click back to back, before the next touch.
 * - A touch's release that reaches a terminal still waiting for an earlier touch press's release
 *   (one that never reached the document) is not that press's: the terminal sends nothing for it
 *   (`foreignRelease`).
 * - Anything else a touch makes outside the panes, and everything a mouse, pen or keyboard makes,
 *   is left alone.
 *
 * Which device made an event is read from that event alone (`touchMade`). Engines without
 * `sourceCapabilities` (WebKit, Firefox) mark only a PointerEvent `click`/`auxclick`/`contextmenu`
 * as a touch's; their plain mousedown, mouseup, mousemove and contextmenu count as a mouse's. A
 * pane's touchend still cancels every touch that is not its tap, so the browser sends no mouse
 * events for it at all. Three known gaps remain there, as before this owner existed (accepted, not
 * held back here):
 * - A finger resting on a pane that is replaced: its mousedown and mouseup reach the new terminal.
 * - On a device with both a mouse and a touch screen, while a mouse button is held down in a pane,
 *   a finger tapping outside every pane: its mouseup cannot be told from the mouse's own release.
 *   It ends the press here, and xterm sends that release to the app as this viewer's input. That
 *   input can take the writer back for this viewer from someone who took it meanwhile: while the
 *   pane follows a known PTY size, only within the input window the press opened
 *   (`TERMINAL_USER_INPUT_WINDOW_MS`); while that size is unknown (`follow` null), at any time.
 * - An orphan plain `contextmenu` (a long press the engine does not make a PointerEvent, on a pane
 *   with no live touch or tap of its own, such as one that replaced the pane the finger is on):
 *   it acts. xterm moves its textarea under the finger and focuses it (the soft keyboard may
 *   open). Focus only: it sends no user input (no keystroke, no mouse-button report), claims no
 *   writer and opens no copy window. A program that enabled focus reports (DECSET 1004) is told
 *   the terminal gained focus (`ESC [ I`, a `reply`, sent only from the writer).
 *
 * Intended, not a gap (owner decision): a touch-marked `contextmenu` of a long press that is still
 * down on its own pane acts before the release is decided (`grant` in `wireTouchScroll`): focus
 * only, as above. A long still press that lifts is a tap like any other.
 */

/** The mouse events a touch makes that xterm or useXterm acts on. */
const TOUCH_MOUSE_EVENTS = [
  "mousemove",
  "mousedown",
  "mouseup",
  "click",
  "auxclick",
  "dblclick",
  "contextmenu",
] as const;

/** One tap decision of a pane (or a long press still held): compared by identity only. */
export type TouchGrant = object;

export type TouchMousePane = {
  /**
   * What lets `event`, a mouse event a touch made, act here: the pane's current tap (or, for a long
   * press's `contextmenu`, its touch still held), or null. A new tap is a new object; every end of
   * the pane's interaction makes it null, so an earlier grant never matches again.
   */
  grant: (event: MouseEvent) => TouchGrant | null;
};

/**
 * xterm of a pane may be waiting with listeners on the document for a press's release:
 * - `REAL`: a mouse or pen press. Ends when a mouse or pen mouseup with no button left reaches the
 *   document (xterm's tracking ends there too), or when the pane goes away.
 * - `{ grant }`: a touch's mousedown that the pane's tap `grant` let through. Its drag may act
 *   while `grant` is the pane's current one. Its release is the next touch mouseup, the only one
 *   a touch can make before its next touchstart: it acts wherever it lands, also after an end of
 *   the interaction, so xterm sends the app the release of the press it sent. The press ends at
 *   that mouseup (as it comes, even held back), at the next touchstart, at a mouse or pen release
 *   reaching the document, or when the pane goes away.
 */
const REAL = "real";
type Press = typeof REAL | { grant: TouchGrant };

type PaneEntry = TouchMousePane & {
  container: HTMLElement;
  press: Press | null;
  /**
   * A touch's press ended here without its release reaching the document (something stopped it,
   * or it never came): xterm may still be waiting for one. Cleared when a release with no button
   * left reaches the document (xterm stops waiting there) or a new press starts here.
   */
  stale: boolean;
  /**
   * The touch's mouseup being dispatched while `stale`: xterm answers it with the release of that
   * earlier press, which is not this touch's to send.
   */
  foreign: Event | null;
};

type Owner = {
  panes: Set<PaneEntry>;
  /** Removes the owner's listeners; null while none are installed. */
  uninstall: (() => void) | null;
};

const owners = new WeakMap<Document, Owner>();

function ownerOf(doc: Document): Owner {
  let owner = owners.get(doc);
  if (!owner) {
    owner = { panes: new Set(), uninstall: null };
    owners.set(doc, owner);
  }
  return owner;
}

type CapabilityEvent = MouseEvent & {
  readonly sourceCapabilities?: { readonly firesTouchEvents: boolean } | null;
};

/** Whether a touch made `event`, from the event's own data only. */
function touchMade(event: MouseEvent): boolean {
  // Chromium says so on every event it makes; a mouse, a pen and a keyboard have it false.
  const { sourceCapabilities } = event as CapabilityEvent;
  if (sourceCapabilities) return sourceCapabilities.firesTouchEvents;
  // Chromium leaves it null only on an event a script made, which no touch made.
  if ("sourceCapabilities" in event) return false;
  // A click, auxclick or contextmenu the engine makes a PointerEvent names its pointer. A
  // keyboard's (the menu key, Enter on a control) has pointerId -1 and no pointer type: no touch's.
  const { pointerType } = event as Partial<PointerEvent>;
  if (typeof pointerType === "string") return pointerType === "touch";
  // A plain mouse event says nothing more: a mouse's (and, on these engines, a touch's too).
  return false;
}

function install(doc: Document, owner: Owner) {
  const paneOf = (target: EventTarget | null) => {
    if (!(target instanceof Node)) return null;
    for (const pane of owner.panes) if (pane.container.contains(target)) return pane;
    return null;
  };

  /** Every touch press ends here; a pane whose press ends may still have xterm waiting. */
  const endTouchPresses = () => {
    for (const pane of owner.panes)
      if (pane.press !== null && pane.press !== REAL) {
        pane.press = null;
        pane.stale = true;
      }
  };

  /** Whether a touch's `event`, aimed at `pane` (null: outside the panes), may act. */
  const admit = (event: MouseEvent, pane: PaneEntry | null): boolean => {
    let pressed: PaneEntry | null = null;
    for (const one of owner.panes) {
      // A mouse's press: no touch event may act in a terminal or end that press.
      if (one.press === REAL) return false;
      if (one.press) pressed = one;
    }
    if (pressed) {
      // A touch's press in progress. Its release is the press's own by the press alone: no touch
      // but its own can make a mouseup before the next touchstart ends it. Its other events are its
      // own while its grant is still current, in its pane or outside.
      if (event.type === "mouseup") return true;
      const press = pressed.press as { grant: TouchGrant };
      return (pane === null || pane === pressed) && pressed.grant(event) === press.grant;
    }
    if (!pane) return true;
    const grant = pane.grant(event);
    if (grant === null) return false;
    // xterm takes it as a press and waits on the document for its release, this press's own.
    if (event.type === "mousedown") {
      pane.press = { grant };
      pane.stale = false;
    }
    return true;
  };

  const onMouse = (event: MouseEvent) => {
    const touch = touchMade(event);
    const pane = paneOf(event.target);
    if (!touch) {
      // A real press: xterm may now wait for its release on the document.
      if (event.type === "mousedown" && pane) pane.press = REAL;
      return;
    }
    const act = admit(event, pane);
    if (event.type === "mouseup" && event.buttons === 0) {
      // A terminal still waiting for an earlier touch press's release: this one is not that press's.
      for (const one of owner.panes) one.foreign = one.stale ? event : null;
      // A touch's press ends at its release, as it comes here: if it reaches the document, xterm
      // stops waiting there; if not, the pane is stale until a release does.
      endTouchPresses();
    }
    if (act) return;
    if (pane) {
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    // Outside the panes: only what a pane's document listeners would take as a press's end or drag.
    if (event.type === "mouseup" || event.type === "mousemove") event.stopImmediatePropagation();
  };

  // A release that reached the document: xterm's document listeners see it next and, with no button
  // left, stop waiting (the selection's stop at any mouseup).
  const onMouseUpReached = (event: MouseEvent) => {
    if (event.buttons !== 0) return;
    const touch = touchMade(event);
    for (const pane of owner.panes) {
      pane.stale = false;
      // A mouse's or pen's release ends every press (a touch's has ended as it came).
      if (!touch) pane.press = null;
    }
  };

  // A new touch: the last tap's mouse events have all come, so its press is over.
  const onTouchStart = () => endTouchPresses();

  for (const type of TOUCH_MOUSE_EVENTS) doc.addEventListener(type, onMouse, true);
  doc.addEventListener("mouseup", onMouseUpReached);
  doc.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
  return () => {
    for (const type of TOUCH_MOUSE_EVENTS) doc.removeEventListener(type, onMouse, true);
    doc.removeEventListener("mouseup", onMouseUpReached);
    doc.removeEventListener("touchstart", onTouchStart, { capture: true });
  };
}

export type TouchMouseClaim = {
  release: () => void;
  /**
   * Whether `event` (the event being dispatched) is a touch's release that this pane's xterm answers
   * with the release of an earlier touch press whose own release never reached the document. That
   * press is not this touch's: what xterm sends for it must not go out.
   */
  foreignRelease: (event: Event | undefined) => boolean;
};

/**
 * Put `container`'s terminal under its document's owner. The first pane in a document installs
 * the owner's listeners and the last one to `release` removes them.
 */
export function claimTouchMouse(container: HTMLElement, pane: TouchMousePane): TouchMouseClaim {
  const doc = container.ownerDocument;
  const owner = ownerOf(doc);
  const entry: PaneEntry = { ...pane, container, press: null, stale: false, foreign: null };
  owner.panes.add(entry);
  if (!owner.uninstall) owner.uninstall = install(doc, owner);
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      owner.panes.delete(entry);
      if (owner.panes.size > 0 || !owner.uninstall) return;
      owner.uninstall();
      owner.uninstall = null;
    },
    foreignRelease: (event) => event !== undefined && entry.foreign === event,
  };
}
