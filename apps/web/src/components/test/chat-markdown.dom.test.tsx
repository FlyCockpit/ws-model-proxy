// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChatMarkdown } from "./chat-markdown";

/** Model answers on the Test page render as markdown, never as raw HTML. */

afterEach(cleanup);

describe("ChatMarkdown", () => {
  it("renders markdown: emphasis, lists, inline code and GFM tables", () => {
    const { container } = render(
      <ChatMarkdown
        content={
          "**bold** and `code`\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n~~gone~~"
        }
      />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector(":not(pre) > code")?.textContent).toBe("code");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("table td")?.textContent).toBe("1");
    expect(container.querySelector("del")?.textContent).toBe("gone");
  });

  it("never renders raw HTML from the answer", () => {
    const { container } = render(
      <ChatMarkdown
        content={
          'Hi <b>there</b>\n\n<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n\n<div onclick="alert(1)">click</div>'
        }
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("div[onclick]")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    // Shown as the text the model wrote, never as elements or attributes.
    expect(container.textContent).toContain("<script>alert(1)</script>");
    expect(container.querySelector("[onerror], [onclick]")).toBeNull();
  });

  it("opens links in a new tab without opener or referrer, and drops script URLs", () => {
    const { container } = render(
      <ChatMarkdown content={"[docs](https://example.com/a) and [bad](javascript:alert(1))"} />,
    );
    const links = container.querySelectorAll("a");
    const docs = links[0];
    expect(docs?.getAttribute("href")).toBe("https://example.com/a");
    expect(docs?.getAttribute("target")).toBe("_blank");
    expect(docs?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(container.innerHTML).not.toContain("javascript:");
  });

  it("shows images as links instead of loading them", () => {
    const { container } = render(
      <ChatMarkdown content={"![a chart](https://example.com/c.png?leak=1)"} />,
    );
    expect(container.querySelector("img")).toBeNull();
    const link = container.querySelector("a");
    expect(link?.textContent).toBe("a chart");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("puts code blocks in monospace inside a horizontal scroller", () => {
    const { container } = render(
      <ChatMarkdown content={"```ts\nconst answer = 42; // a very long line\n```"} />,
    );
    const pre = container.querySelector("pre");
    expect(pre?.className).toContain("font-mono");
    expect(pre?.querySelector("code")?.textContent).toBe(
      "const answer = 42; // a very long line\n",
    );
    const scroller = pre?.parentElement;
    expect(scroller?.className).toContain("overflow-x-auto");
    expect(scroller?.className).toContain("overscroll-x-contain");
  });

  it("renders a code fence that is still streaming", () => {
    const { container, rerender } = render(<ChatMarkdown content={"Here:\n\n```py\nprint("} />);
    expect(container.querySelector("pre code")?.textContent).toBe("print(\n");
    rerender(<ChatMarkdown content={"Here:\n\n```py\nprint(1)\n```\n\nDone **now**"} />);
    expect(container.querySelector("pre code")?.textContent).toBe("print(1)\n");
    expect(container.querySelector("strong")?.textContent).toBe("now");
  });
});
