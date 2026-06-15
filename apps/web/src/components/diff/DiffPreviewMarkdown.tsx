import { useMemo, lazy, Suspense } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { makeRemarkDiffMarkers } from "@/lib/remark-diff-markers";

/** Lazy-loaded MermaidBlock - only fetched when a mermaid fence appears in the preview. */
const LazyMermaidBlock = lazy(() => import("../chat/MermaidBlock"));

/**
 * react-markdown component overrides for the diff preview. The only behavior
 * we add over the defaults is mermaid handling: fenced ```mermaid blocks must
 * render as diagrams, not raw code (the diff preview previously showed them as
 * plain text). Everything else falls through to react-markdown defaults so the
 * diff markers and global typography styles keep working.
 */
const COMPONENTS: Components = {
  pre({ node, children, ...props }) {
    // Unwrap the <pre> wrapper around a mermaid fence so the rendered diagram
    // isn't boxed inside code-block styling. Non-mermaid code blocks keep their
    // <pre> (and the data-diff-added marker the remark plugin attaches).
    const child = node?.children?.[0];
    const className = child?.type === "element" ? child.properties?.className : undefined;
    const isMermaid = Array.isArray(className) && className.includes("language-mermaid");
    if (isMermaid) return <>{children}</>;
    return <pre {...props}>{children}</pre>;
  },
  code({ node: _node, className, children, ...props }) {
    const langMatch = /language-(\S+)/.exec(className ?? "");
    if (langMatch?.[1] === "mermaid") {
      const code = String(children).replace(/\n$/, "");
      return (
        <Suspense
          fallback={
            <pre className="rounded bg-muted/30 p-3 text-[12px] font-mono overflow-x-auto">
              <code>{code}</code>
            </pre>
          }
        >
          {/* Preview reconstructs the final file content, so it is never mid-stream. */}
          <LazyMermaidBlock code={code} isStreaming={false} />
        </Suspense>
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};

/** Props for the inner Markdown renderer used by DiffPreview. */
interface DiffPreviewMarkdownProps {
  /** Reconstructed file content (markdown source). */
  readonly content: string;
  /** 1-based line numbers within `content` that were added by this diff. */
  readonly addedLines: ReadonlySet<number>;
}

/**
 * The actual diff-aware Markdown renderer. Kept in a separate module so
 * DiffPreview can lazy-load it — the react-markdown + remark-gfm + plugin
 * surface is meaningful weight to defer until the user opens Preview.
 *
 * Highlighting is delivered as `[data-diff-added]` attributes set by the
 * remark plugin; Tailwind arbitrary selectors style any descendant that
 * carries the attribute. We deliberately don't override per-tag
 * components — letting react-markdown render defaults keeps the surface
 * minimal and avoids competing with the global Markdown styles.
 */
export default function DiffPreviewMarkdown({
  content,
  addedLines,
}: DiffPreviewMarkdownProps) {
  // Memoise the plugin list so we don't reinstantiate the closures every
  // render — only when the added-lines identity changes.
  const remarkPlugins = useMemo(
    () => [remarkGfm, makeRemarkDiffMarkers(addedLines)],
    [addedLines],
  );

  return (
    <div
      className={[
        // Typography baseline. We can't use the chat's prose stack here —
        // we need finer control over how the diff highlight interacts with
        // block margins.
        "space-y-3 break-words",
        // Diff-added block treatment: a thin left-edge accent bar in the
        // add-gutter color. Rendered as an inset box-shadow because the
        // codebase rule forbids borders > 1px for this kind of stripe.
        // We deliberately do NOT apply a full background tint — when most
        // of a markdown file is a single added block (new ADRs, fresh
        // docs), full-bleed green overwhelms the content and makes the
        // preview read as a wall of color. An edge marker keeps the
        // "this block was touched" signal without that noise.
        // Only style innermost marked nodes — the remark plugin tags both
        // containers (blockquote) and their children (p), and stacking
        // inset shadows + padding on nested matches reads as a thick blob.
        "[&_[data-diff-added]:not(:has([data-diff-added]))]:shadow-[inset_2px_0_0_var(--diff-add-gutter)]",
        "[&_[data-diff-added]:not(:has([data-diff-added]))]:pl-3",
        // Basic typographic defaults for unstyled tags.
        "[&_h1]:text-base [&_h1]:font-semibold [&_h1]:mt-4",
        "[&_h2]:text-[15px] [&_h2]:font-semibold [&_h2]:mt-4",
        "[&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-3",
        "[&_p]:leading-relaxed",
        "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_li]:my-1",
        "[&_code]:rounded [&_code]:bg-muted/40 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[12px] [&_code]:font-mono",
        "[&_pre]:rounded [&_pre]:bg-muted/30 [&_pre]:p-3 [&_pre]:text-[12px] [&_pre]:font-mono [&_pre]:overflow-x-auto",
        // Blockquote: indented italic with a faint bg tint instead of a
        // left stripe (border-l > 1px is banned per impeccable).
        "[&_blockquote]:bg-muted/15 [&_blockquote]:px-3 [&_blockquote]:py-1 [&_blockquote]:italic [&_blockquote]:text-muted-foreground [&_blockquote]:rounded-sm",
        "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
        "[&_hr]:my-4 [&_hr]:border-border/40",
        "[&_table]:border-collapse [&_table]:my-2",
        "[&_th]:border [&_th]:border-border/40 [&_th]:px-2 [&_th]:py-1",
        "[&_td]:border [&_td]:border-border/40 [&_td]:px-2 [&_td]:py-1",
      ].join(" ")}
    >
      <ReactMarkdown remarkPlugins={remarkPlugins} components={COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
