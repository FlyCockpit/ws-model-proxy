import { cn } from "@ws-model-proxy/ui/lib/utils";
import { memo, useId } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { WideContent } from "@/components/wide-content";

/**
 * Markdown in model answers. Raw HTML is never rendered: react-markdown shows it as text (no
 * rehype-raw). URLs go through react-markdown's default `urlTransform` (no `javascript:`),
 * links open in a new tab without an opener or referrer, images are links (a reply cannot
 * make the browser fetch a URL by itself), and wide code blocks and tables scroll on their own.
 */
const components: Components = {
  a: ({ node: _node, children, href, ...props }) => {
    // A URL the default transform dropped (`javascript:` and the like) is text.
    if (!href) return <span>{children}</span>;
    // In-answer targets (footnotes) stay in the page.
    if (href.startsWith("#")) {
      return (
        <a {...props} href={href}>
          {children}
        </a>
      );
    }
    return (
      <a {...props} href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  // An answer's headings sit below the page's own.
  h1: ({ node: _node, ...props }) => <h3 {...props} />,
  h2: ({ node: _node, ...props }) => <h4 {...props} />,
  h3: ({ node: _node, ...props }) => <h5 {...props} />,
  h4: ({ node: _node, ...props }) => <h6 {...props} />,
  h5: ({ node: _node, ...props }) => <h6 {...props} />,
  img: ({ src, alt }) =>
    typeof src === "string" && src ? (
      <a href={src} target="_blank" rel="noopener noreferrer">
        {alt || src}
      </a>
    ) : (
      (alt ?? null)
    ),
  pre: ({ node: _node, className, ...props }) => (
    <WideContent className="rounded-md border bg-muted/60">
      <pre
        className={cn("w-max min-w-full p-3 font-mono text-xs leading-relaxed", className)}
        {...props}
      />
    </WideContent>
  ),
  table: ({ node: _node, ...props }) => (
    <WideContent>
      <table {...props} />
    </WideContent>
  ),
};

type HastNode = {
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const FOOTNOTE_LABEL_ID = "footnote-label";

/** `clobberPrefix` leaves the footnote section's label id fixed: prefix it and its references. */
function rehypePrefixFootnoteLabel(prefix: string) {
  const prefixed = `${prefix}${FOOTNOTE_LABEL_ID}`;
  const visit = (node: HastNode) => {
    const properties = node.properties;
    if (properties) {
      if (properties.id === FOOTNOTE_LABEL_ID) properties.id = prefixed;
      const describedBy = properties.ariaDescribedBy;
      if (Array.isArray(describedBy)) {
        properties.ariaDescribedBy = describedBy.map((id) =>
          id === FOOTNOTE_LABEL_ID ? prefixed : id,
        );
      }
    }
    node.children?.forEach(visit);
  };
  return (tree: HastNode) => visit(tree);
}

const MARKDOWN_CLASS_NAME =
  "min-w-0 max-w-full break-words text-sm leading-relaxed [&>*+*]:mt-3 [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:border-s-2 [&_blockquote]:ps-3 [&_blockquote]:text-muted-foreground [&_code]:font-mono [&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:text-[0.9em] [&_h3]:text-lg [&_h3]:font-semibold [&_h4]:text-base [&_h4]:font-semibold [&_h5]:font-semibold [&_h6]:font-semibold [&_hr]:border-border [&_li]:ms-5 [&_ol]:list-decimal [&_ul]:list-disc [&_table]:text-xs [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:text-start";

/** A model answer as markdown; re-renders only when its text changes (while streaming). */
export const ChatMarkdown = memo(function ChatMarkdown({ content }: { content: string }) {
  // Footnote ids stay unique when several answers have footnotes.
  const id = useId();
  return (
    <div className={MARKDOWN_CLASS_NAME}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        remarkRehypeOptions={{ clobberPrefix: `${id}-` }}
        rehypePlugins={[[rehypePrefixFootnoteLabel, `${id}-`]]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
