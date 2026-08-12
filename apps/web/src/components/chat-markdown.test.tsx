import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatMarkdown, sanitizeMarkdownUrl } from "./chat-markdown";

describe("sanitizeMarkdownUrl", () => {
  it("allows safe protocols and relative targets", () => {
    expect(sanitizeMarkdownUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(sanitizeMarkdownUrl("http://example.com")).toBe("http://example.com");
    expect(sanitizeMarkdownUrl("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(sanitizeMarkdownUrl("tel:+15551212")).toBe("tel:+15551212");
    expect(sanitizeMarkdownUrl("#section")).toBe("#section");
    expect(sanitizeMarkdownUrl("/docs/intro")).toBe("/docs/intro");
    expect(sanitizeMarkdownUrl("./relative")).toBe("./relative");
  });

  it("drops dangerous schemes", () => {
    expect(sanitizeMarkdownUrl("javascript:alert(1)")).toBe("");
    expect(sanitizeMarkdownUrl("JAVASCRIPT:alert(1)")).toBe("");
    expect(sanitizeMarkdownUrl("data:text/html;base64,aaaa")).toBe("");
    expect(sanitizeMarkdownUrl("vbscript:msgbox(1)")).toBe("");
  });
});

describe("ChatMarkdown", () => {
  it("renders GFM basics without raw HTML", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown content={"**bold** and `code`\n\n<script>alert(1)</script>\n\n- item"} />,
    );
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<li>");
    // react-markdown with skipHtml must not emit a live script element.
    expect(html).not.toContain("<script>");
  });

  it("highlights fenced code blocks by their declared language", () => {
    const html = renderToStaticMarkup(<ChatMarkdown content={"```ts\nconst answer = 42;\n```"} />);
    expect(html).toContain("hljs");
    expect(html).toContain("hljs-keyword");
  });

  it("sanitizes javascript links", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown content={"[x](javascript:alert(1)) and [ok](https://example.com)"} />,
    );
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://example.com"');
  });

  it("renders hex colors with contrast-aware swatches", () => {
    const html = renderToStaticMarkup(<ChatMarkdown content={"Dark #123abc, light #fefefe."} />);
    expect(html).toContain("background-color:#123abc");
    expect(html).toContain("color:#ffffff");
    expect(html).toContain("background-color:#fefefe");
    expect(html).toContain("color:#000000");
  });
});
