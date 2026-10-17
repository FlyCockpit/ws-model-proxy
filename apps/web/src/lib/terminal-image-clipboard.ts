/** Keep Office-style rich text, while allowing a browser's image + URL copy. */
export function clipboardPrefersText(
  types: readonly string[],
  text: string,
  html: string,
): boolean {
  if (text.length === 0) return false;
  if (types.includes("text/rtf") || types.includes("application/rtf")) return true;
  if (!types.includes("text/html")) return false;
  // Spreadsheet cell text (including whitespace) must not become an image.
  if (!/^(?:https?:\/\/|blob:|data:image\/)\S+$/i.test(text.trim())) return true;
  const template = document.createElement("template");
  // Template contents remain inert, including image/network elements.
  template.innerHTML = html;
  let images = 0;
  const imageOnly = (parent: ParentNode): boolean =>
    Array.from(parent.childNodes).every((node) => {
      if (node.nodeType === Node.COMMENT_NODE) return true;
      if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").trim().length === 0;
      if (!(node instanceof Element)) return false;
      if (node.tagName === "IMG") {
        images += 1;
        return true;
      }
      if (node.tagName === "META") return node.hasAttribute("charset");
      if (node.tagName === "SOURCE") return node.parentElement?.tagName === "PICTURE";
      return (
        ["HTML", "HEAD", "BODY", "DIV", "SPAN", "A", "PICTURE"].includes(node.tagName) &&
        imageOnly(node)
      );
    });
  return !(imageOnly(template.content) && images === 1);
}
