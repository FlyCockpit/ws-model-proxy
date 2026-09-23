import { describe, expect, it } from "vitest";

import { renderPoolExternalProviderNotice } from "./pool-external-provider";

describe("renderPoolExternalProviderNotice", () => {
  it("escapes the pool name and does not include provider secrets", () => {
    const { subject, html } = renderPoolExternalProviderNotice({
      name: "<Ada>",
      poolName: 'Shared <script>alert("x")</script>',
      locale: "en-US",
    });

    expect(subject).toContain("Shared");
    expect(subject).not.toContain("<script>");
    expect(html).toContain("&lt;Ada&gt;");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("may now send requests to an external provider");
    expect(html).not.toContain("sk-");
  });

  it("uses the Spanish bundle", () => {
    const { html } = renderPoolExternalProviderNotice({
      name: "Ada",
      poolName: "Compartido",
      locale: "es-MX",
    });

    expect(html).toContain('lang="es-MX"');
    expect(html).toContain("proveedor externo");
    expect(html).not.toContain("may now send requests");
  });
});
