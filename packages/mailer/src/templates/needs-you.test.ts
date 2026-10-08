import { describe, expect, it } from "vitest";

import enBundle from "../locales/en-US/needs-you.json";
import esBundle from "../locales/es-MX/needs-you.json";
import { NEEDS_YOU_KINDS, renderNeedsYou } from "./needs-you";

describe("renderNeedsYou", () => {
  const terminals = "https://example.com/en-US/terminals";
  const runtime = "https://example.com/en-US/runtimes/rt1";

  it("names a waiting step and links to Terminals", () => {
    const { subject, html } = renderNeedsYou({
      kind: "step",
      name: "qwen-32b",
      actionUrl: terminals,
      locale: "en-US",
    });
    expect(subject).toBe("qwen-32b: a step waits for you");
    expect(html).toContain('<html lang="en-US">');
    expect(html).toContain("<strong>qwen-32b</strong>");
    expect(html).toContain("Open Terminals");
    expect(html).toContain(terminals);
  });

  it("names each need in its own words", () => {
    const restart = renderNeedsYou({
      kind: "restart",
      name: "qwen",
      actionUrl: runtime,
      locale: "en-US",
    });
    expect(restart.subject).toBe("qwen needs a restart");
    expect(restart.html).toContain("Open the runtime");
    const markStopped = renderNeedsYou({
      kind: "mark_stopped",
      name: "qwen",
      actionUrl: runtime,
      locale: "en-US",
    });
    expect(markStopped.subject).toBe("qwen: mark as stopped");
    expect(markStopped.html).toContain("Mark as stopped");
    const queued = renderNeedsYou({
      kind: "queued_command",
      name: "gpu-box",
      actionUrl: terminals,
      locale: "en-US",
    });
    expect(queued.subject).toBe("An agent queued a command for you on gpu-box");
    expect(queued.html).toContain("the node <strong>gpu-box</strong>");
  });

  it("renders in Spanish", () => {
    const { subject, html } = renderNeedsYou({
      kind: "restart",
      name: "qwen",
      actionUrl: runtime,
      locale: "es-MX",
    });
    expect(subject).toBe("qwen necesita reiniciarse");
    expect(html).toContain('<html lang="es-MX">');
    expect(html).toContain("reinícialo");
  });

  it("ships the same keys in every locale, with no 0.3 wording", () => {
    expect(Object.keys(esBundle).sort()).toEqual(Object.keys(enBundle).sort());
    for (const kind of NEEDS_YOU_KINDS) {
      for (const locale of ["en-US", "es-MX"]) {
        const { subject, html } = renderNeedsYou({ kind, name: "x", actionUrl: runtime, locale });
        expect(`${subject} ${html}`).not.toMatch(/deployment|despliegue|recipe|receta/i);
      }
    }
  });

  it("escapes the name, keeps the subject on one line and refuses a non-HTTP link", () => {
    const { subject, html } = renderNeedsYou({
      kind: "step",
      name: "<script>x</script>\r\nBcc: a@b",
      actionUrl: terminals,
      locale: "fr-FR",
    });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain('<html lang="en-US">');
    expect(subject).not.toMatch(/[\r\n]/);
    expect(() =>
      renderNeedsYou({
        kind: "step",
        name: "x",
        actionUrl: "javascript:alert(1)",
        locale: "en-US",
      }),
    ).toThrow();
  });

  it("never expands replacement patterns in the name", () => {
    const { subject, html } = renderNeedsYou({
      kind: "step",
      name: "a$&b$'c",
      actionUrl: terminals,
      locale: "en-US",
    });
    expect(html).toContain("<strong>a$&amp;b$&#39;c</strong>");
    expect(subject).toBe("a$&b$'c: a step waits for you");
  });
});
