// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { clipboardPrefersText } from "./terminal-image-clipboard";

describe("image and rich-text clipboard precedence", () => {
  it.each([
    ["Name\tValue\nExample\t42", "<table><tr><td>Name</td><td>Value</td></tr></table>"],
    ["ordinary slide text", '<img src="data:image/png;base64,example">'],
    ["https://example.test/image.png\nMore context", '<img src="image.png">'],
    ["https://example.test", '<p>https://example.test</p><img src="image.png">'],
    ["https://example.test", '<img src="a.png"><img src="b.png">'],
    [" ", '<img src="image.png">'],
  ])("preserves rich text for %s", (text, html) => {
    expect(clipboardPrefersText(["text/plain", "text/html", "Files"], text, html)).toBe(true);
  });

  it.each([
    '<img src="https://example.test/image.png">',
    '<!--StartFragment--><img src="https://example.test/image.png"><!--EndFragment-->',
    '<meta charset="utf-8"><a href="https://example.test/image.png"><img src="image.png"></a>',
    '<div><picture><source srcset="image.webp"><img src="image.png"></picture></div>',
  ])("uploads a single image accompanied by its URL: %s", (html) => {
    expect(
      clipboardPrefersText(
        ["text/plain", "text/html", "Files"],
        "https://example.test/image.png",
        html,
      ),
    ).toBe(false);
  });

  it("preserves RTF text even with a URL and image-only HTML", () => {
    expect(
      clipboardPrefersText(
        ["text/rtf", "text/html"],
        "https://example.test/image.png",
        '<img src="image.png">',
      ),
    ).toBe(true);
  });
});
