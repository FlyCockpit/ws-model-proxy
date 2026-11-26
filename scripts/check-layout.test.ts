import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { judgeLayout, type Probe } from "./check-layout.ts";

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
