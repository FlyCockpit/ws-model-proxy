import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
};

const HEX_COLOR_PATTERN = /#[0-9a-fA-F]{3,8}\b/g;

function hexColorTextColor(hex: string): "#000000" | "#ffffff" {
  const digits = hex.slice(1);
  const expanded =
    digits.length === 3 || digits.length === 4
      ? digits
          .slice(0, 3)
          .split("")
          .map((digit) => digit.repeat(2))
          .join("")
      : digits.slice(0, 6);
  const channels = [0, 2, 4].map(
    (offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16) / 255,
  );
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
  // This is the point where black and white have equal contrast; choosing the
  // stronger of the two keeps the label legible on every opaque hex swatch.
  return luminance > 0.179 ? "#000000" : "#ffffff";
}

function hexColorNodes(value: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  let lastIndex = 0;
  for (const match of value.matchAll(HEX_COLOR_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) nodes.push({ type: "text", value: value.slice(lastIndex, index) });
    const hex = match[0];
    nodes.push({
      type: "hexColor",
      value: hex,
      data: {
        hName: "span",
        hProperties: {
          className: ["chat-hex-color"],
          style: { backgroundColor: hex, color: hexColorTextColor(hex) },
        },
      },
    });
    lastIndex = index + hex.length;
  }
  if (nodes.length === 0) return [{ type: "text", value }];
  if (lastIndex < value.length) nodes.push({ type: "text", value: value.slice(lastIndex) });
  return nodes;
}

function highlightHexColors(node: MarkdownNode): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === "text" && child.value) return hexColorNodes(child.value);
    highlightHexColors(child);
    return [child];
  });
}

/** Turn hex color text into contrast-aware swatches without permitting HTML. */
function remarkHexColorHighlight() {
  return (tree: MarkdownNode) => highlightHexColors(tree);
}

/**
 * Safe GFM rendering for chat previews.
 *
 * - Raw HTML in model output is never rendered (`skipHtml`).
 * - Link/image URLs are sanitized: only http(s), mailto, tel, and in-page
 *   relative/hash targets are kept; `javascript:`, `data:`, etc. are dropped.
 */
export function sanitizeMarkdownUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    return "";
  }
  // In-document and root-relative targets are fine.
  if (trimmed.startsWith("#") || trimmed.startsWith("/")) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    if (
      protocol === "http:" ||
      protocol === "https:" ||
      protocol === "mailto:" ||
      protocol === "tel:"
    ) {
      return trimmed;
    }
  } catch {
    // Relative paths without a leading slash (e.g. `./foo`) — allow only if they
    // do not introduce a scheme-like prefix.
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
      return trimmed;
    }
  }
  return "";
}

const markdownClassName =
  "break-words text-sm leading-relaxed [&_.chat-hex-color]:inline-block [&_.chat-hex-color]:rounded-sm [&_.chat-hex-color]:px-1.5 [&_.chat-hex-color]:py-0.5 [&_.chat-hex-color]:font-mono [&_.chat-hex-color]:text-[0.9em] [&_a]:text-primary [&_a]:underline [&_a]:decoration-primary/70 [&_a]:underline-offset-2 [&_a]:transition-colors [&_a:hover]:decoration-2 [&_a:focus-visible]:rounded-sm [&_a:focus-visible]:outline-none [&_a:focus-visible]:ring-2 [&_a:focus-visible]:ring-ring [&_a:focus-visible]:ring-offset-2 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-background [&_code]:px-1 [&_code]:py-0.5 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:text-lg [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_ol]:ml-5 [&_ol]:list-decimal [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-background [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:w-full [&_th]:border [&_th]:p-2 [&_td]:border [&_td]:p-2";

export function ChatMarkdown({ content }: { content: string }) {
  return (
    <div className={markdownClassName}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkHexColorHighlight]}
        rehypePlugins={[rehypeHighlight]}
        skipHtml
        urlTransform={sanitizeMarkdownUrl}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
