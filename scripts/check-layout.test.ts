import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type CheckRun, parseEvalOutput } from "./browser-check-lib.ts";
import { judgeLayout, LOADING_MARKER, measure, type Probe, SETTLED } from "./check-layout.ts";

const good: Probe = {
  vw: 1280,
  docScroll: 0,
  header: true,
  main: { scrollable: false, scrollbar: 0 },
  rules: [
    { name: "header <hr>", left: 0, right: 1280, inMain: false },
    { name: "sub-nav border-b", left: 0, right: 1280, inMain: true },
  ],
  toast: null,
};

const toast = {
  dark: true,
  fill: "33,37,39",
  popover: "33,37,39",
  title: 15.8,
  badge: 5.2,
  button: 15.8,
};

describe("judgeLayout", () => {
  it("passes a page in the shell whose rules span the viewport", () => {
    assert.deepEqual(judgeLayout("admin users", good, {}), []);
  });

  it("reports a page outside the shell", () => {
    assert.match(
      judgeLayout("404", { ...good, header: false, main: null }, {}).join("\n"),
      /no <main[\s\S]*no shell header/,
    );
  });

  it("reports a document scroll, a reserved gutter and rules stopped short by it", () => {
    const bad = judgeLayout(
      "admin",
      {
        ...good,
        docScroll: 12,
        main: { scrollable: false, scrollbar: 15 },
        rules: [{ name: "sub-nav border-b", left: 0, right: 1265, inMain: true }],
      },
      {},
    );
    assert.equal(bad.length, 3, bad.join("\n"));
    assert.match(bad.join("\n"), /document scrolls by 12px/);
    assert.match(bad.join("\n"), /reserves a 15px scrollbar gutter on a page that does not scroll/);
    assert.match(bad.join("\n"), /sub-nav border-b spans 0…1265px, not 0…1280px/);
  });

  it("lets a rule inside a scrolling scroller meet the visible scrollbar, never one outside it", () => {
    const scrolling = { scrollable: true, scrollbar: 15 };
    assert.deepEqual(
      judgeLayout(
        "admin long",
        {
          ...good,
          main: scrolling,
          rules: [
            { name: "header <hr>", left: 0, right: 1280, inMain: false },
            { name: "sub-nav border-b", left: 0, right: 1265, inMain: true },
          ],
        },
        {},
      ),
      [],
    );
    assert.equal(
      judgeLayout(
        "admin long",
        {
          ...good,
          main: scrolling,
          rules: [{ name: "header <hr>", left: 0, right: 1265, inMain: false }],
        },
        {},
      ).length,
      1,
    );
  });

  it("checks the toast fill against the theme's popover, its contrast and the stored theme", () => {
    assert.deepEqual(judgeLayout("toast dark", { ...good, toast }, { toast: "dark" }), []);
    const inverted = judgeLayout(
      "toast dark",
      { ...good, toast: { ...toast, fill: "242,242,242", title: 3.4, badge: 3.4, button: 3.4 } },
      { toast: "dark" },
    );
    assert.equal(inverted.length, 4, inverted.join("\n"));
    assert.match(inverted[0] ?? "", /filled 242,242,242, not the dark theme's popover 33,37,39/);
    const actionDark = { toast: "dark", action: true } as const;
    assert.match(
      judgeLayout("toast dark", { ...good, toast: { ...toast, button: null } }, actionDark).join(
        "",
      ),
      /the toast has no action/,
    );
    assert.match(
      judgeLayout("toast dark", { ...good, toast: { ...toast, button: 3.1 } }, actionDark).join(""),
      /toast action contrast 3.1:1 is below 4.5:1/,
    );
    assert.match(
      judgeLayout("toast light", good, { toast: "light" }).join(""),
      /no toast appeared/,
    );
    assert.match(
      judgeLayout("toast light", { ...good, toast }, { toast: "light" }).join(""),
      /stored light theme lost to the OS/,
    );
  });
});

describe("parseEvalOutput", () => {
  it("parses a JSON-encoded page result once more and keeps other values", () => {
    assert.deepEqual(parseEvalOutput(JSON.stringify(JSON.stringify({ a: 1 }))), { a: 1 });
    assert.equal(parseEvalOutput(JSON.stringify(JSON.stringify("settled"))), "settled");
    assert.equal(parseEvalOutput("true"), true);
  });

  it("rejects a bare string result, so page scripts must JSON-encode strings", () => {
    assert.throws(() => parseEvalOutput(JSON.stringify("settled")), SyntaxError);
  });
});

describe("SETTLED", () => {
  /**
   * Runs the page script against a fake visible <main> whose height follows
   * `heights`, then stays at the last. `skeleton[i]` says whether read i still
   * finds a loading marker (the last value holds after the list ends).
   */
  const settle = async (heights: number[] | null, skeleton: boolean[] = [false]) => {
    let reads = 0;
    const selectors: string[] = [];
    const main = {
      checkVisibility: () => true,
      get scrollHeight() {
        reads++;
        return heights ? (heights[Math.min(reads - 1, heights.length - 1)] ?? 0) : 0;
      },
      querySelector: (selector: string) => {
        selectors.push(selector);
        return skeleton[Math.min(reads - 1, skeleton.length - 1)] ? {} : null;
      },
    };
    // A suspended route can leave a hidden <main> before the visible one.
    const hidden = { checkVisibility: () => false, scrollHeight: 0, querySelector: () => ({}) };
    // The page script reads the globals `document` and `setTimeout`; parameters
    // stand in for them, and the timer fires at once, so the 8s limit costs no real time.
    const run = new Function("document", "setTimeout", `return ${SETTLED};`) as (
      doc: unknown,
      timer: (done: () => void) => void,
    ) => Promise<string>;
    const value = await run({ querySelectorAll: () => (heights ? [hidden, main] : []) }, (done) =>
      done(),
    );
    // Through the same adapter as a real run: agent-browser prints the value as JSON.
    const settled = parseEvalOutput(JSON.stringify(value));
    return { settled, reads, selectors };
  };

  it("waits until the content stops growing (rows arrive after the heading)", async () => {
    const { settled, reads } = await settle([681, 681, 986, 1200]);
    assert.equal(settled, "settled");
    // Three changes, then five unchanged reads in a row.
    assert.equal(reads, 9);
  });

  it("does not settle on a skeleton that holds one height before the data arrives", async () => {
    // A skeleton at 681px for 10 reads (stable for well over five), then the rows.
    const heights = [...Array(10).fill(681), 1200];
    const skeleton = [...Array(10).fill(true), false];
    const { settled, reads, selectors } = await settle(heights, skeleton);
    assert.equal(settled, "settled");
    // Ten skeleton reads count for nothing; then the loaded height, then five unchanged reads.
    assert.equal(reads, 16);
    assert.equal(selectors[0], LOADING_MARKER);
  });

  it("looks for the app's skeleton and busy markers", () => {
    assert.match(LOADING_MARKER, /\[data-slot="skeleton"\]/);
    assert.match(LOADING_MARKER, /\[aria-busy="true"\]/);
    assert.match(LOADING_MARKER, /\[data-route-skeleton\]/);
  });

  it("reports a page still loading after 8s, distinct from one that keeps changing", async () => {
    const loading = await settle([681], [true]);
    assert.equal(loading.settled, "loading");
    assert.equal(loading.reads, 80);
    const growing = Array.from({ length: 100 }, (_, i) => 500 + i * 10);
    const changing = await settle(growing);
    assert.equal(changing.settled, "changing");
    assert.equal(changing.reads, 80);
  });

  it("does not wait on a page without the app's scroller", async () => {
    const { settled, reads } = await settle(null);
    assert.deepEqual({ settled, reads }, { settled: "settled", reads: 0 });
  });
});

describe("layout measurement", () => {
  it("reports loading and changing content before measuring geometry", async (t) => {
    t.mock.method(console, "log", () => {});
    for (const state of ["loading", "changing"]) {
      let dark = false;
      let probes = 0;
      const browser: CheckRun["browser"] = {
        async run(args) {
          if (args[0] === "set" && args[1] === "media") dark = args[2] === "light";
          return "true";
        },
        async evalJson<T>(script: string): Promise<T> {
          if (script === SETTLED) return state as T;
          probes++;
          return { ...good, toast: { ...toast, dark } } as T;
        },
        close() {},
      };
      const failures = await measure({ base: "http://localhost:3000", browser, args: [] });
      assert.equal(failures.length, 8);
      for (const failure of failures)
        assert.match(
          failure,
          state === "loading"
            ? /still showing a loading skeleton after 8s/
            : /content kept changing for 8s/,
        );
      // Only the two toast probes run; no skeleton/changing page is measured.
      assert.equal(probes, 2);
    }
  });
});
