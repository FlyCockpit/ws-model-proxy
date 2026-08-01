import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
  "break-words text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-background [&_code]:px-1 [&_code]:py-0.5 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:text-lg [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_ol]:ml-5 [&_ol]:list-decimal [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-background [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:w-full [&_th]:border [&_th]:p-2 [&_td]:border [&_td]:p-2";

export function ChatMarkdown({ content }: { content: string }) {
  return (
    <div className={markdownClassName}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={sanitizeMarkdownUrl}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
