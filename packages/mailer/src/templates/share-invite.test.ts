import { describe, expect, it } from "vitest";

import { renderShareInvite } from "./share-invite";

const base = {
  ownerName: "Ana",
  target: { kind: "pool" as const, callableId: "ana/chat" },
  inviteUrl: "https://proxy.example.com/en-US/signup?invite=wsmp_inv_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  expiresAt: new Date("2026-10-20T00:00:00Z"),
};

describe("renderShareInvite", () => {
  it("names the owner, the pool and the link", () => {
    const { subject, html } = renderShareInvite({ ...base, locale: "en-US" });
    expect(subject).toBe("Ana shared a pool with you");
    expect(html).toContain("<code>ana/chat</code>");
    expect(html).toContain(base.inviteUrl);
    expect(html).toContain("October 20, 2026");
  });

  it("names a shared runtime definition, escaped", () => {
    const { subject, html } = renderShareInvite({
      ...base,
      target: { kind: "runtime", name: "Qwen <b>32B</b>" },
      locale: "en-US",
    });
    expect(subject).toBe("Ana shared a runtime definition with you");
    expect(html).toContain("<strong>Qwen &lt;b&gt;32B&lt;/b&gt;</strong>");
    expect(html).not.toContain("<code>");
    expect(html).toContain(base.inviteUrl);
  });

  it("blanks control characters in a runtime name and caps its length", () => {
    const { html } = renderShareInvite({
      ...base,
      target: { kind: "runtime", name: `Qwen\u202E\r\n${"x".repeat(300)}` },
      locale: "en-US",
    });
    const name = /<strong>([^<]*)<\/strong>/.exec(html)?.[1] ?? "";
    expect(name).not.toMatch(/[\u202E\r\n]/);
    expect(name.length).toBe(120);
  });

  it("renders the Spanish bundle", () => {
    const { subject, html } = renderShareInvite({ ...base, locale: "es-MX" });
    expect(subject).toBe("Ana compartió un pool contigo");
    expect(html).toContain('<html lang="es-MX">');
  });

  it("escapes the owner's name in the body and strips control characters in the subject", () => {
    const { subject, html } = renderShareInvite({
      ...base,
      ownerName: "<script>x</script>\r\nBcc: a@b",
      locale: "en-US",
    });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(subject).not.toMatch(/[\r\n]/);
  });

  it("refuses a non-HTTP link", () => {
    expect(() =>
      renderShareInvite({ ...base, inviteUrl: "javascript:alert(1)", locale: "en-US" }),
    ).toThrow();
  });
});
