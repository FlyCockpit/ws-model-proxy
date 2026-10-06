import { describe, expect, it } from "vitest";

import { renderDeploymentNeedsYou } from "./deployment-needs-you";

describe("renderDeploymentNeedsYou", () => {
  const base = {
    endpoint: "inst-qwen-abc",
    deploymentsUrl: "https://example.com/en-US/dashboard/deployments",
  };

  it("explains a waiting step and links to the deployments page", () => {
    const { subject, html } = renderDeploymentNeedsYou({ ...base, need: "step", locale: "en-US" });
    expect(subject).toBe("A deployment needs you");
    expect(html).toContain('<html lang="en-US">');
    expect(html).toContain("<strong>inst-qwen-abc</strong>");
    expect(html).toContain("terminal on the node");
    expect(html).toContain("https://example.com/en-US/dashboard/deployments");
  });

  it("explains a stopped interactive start in Spanish", () => {
    const { subject, html } = renderDeploymentNeedsYou({
      ...base,
      need: "restart",
      locale: "es-MX",
    });
    expect(subject).toBe("Un despliegue te necesita");
    expect(html).toContain('<html lang="es-MX">');
    expect(html).toContain("reinícialo");
  });

  it("escapes the endpoint and refuses a non-HTTP link", () => {
    const { html } = renderDeploymentNeedsYou({
      ...base,
      endpoint: "<script>x</script>",
      need: "step",
      locale: "fr-FR",
    });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain('<html lang="en-US">');
    expect(() =>
      renderDeploymentNeedsYou({
        ...base,
        deploymentsUrl: "javascript:alert(1)",
        need: "step",
        locale: "en-US",
      }),
    ).toThrow();
  });

  it("never expands replacement patterns in the endpoint", () => {
    const { html } = renderDeploymentNeedsYou({
      ...base,
      endpoint: "a$&b$'c",
      need: "step",
      locale: "en-US",
    });
    expect(html).toContain("<strong>a$&amp;b$&#39;c</strong>");
  });
});
