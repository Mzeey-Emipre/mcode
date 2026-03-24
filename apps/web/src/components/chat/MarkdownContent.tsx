import { memo } from "react";
import type { Element } from "hast";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Props for {@link MarkdownContent}. */
interface MarkdownContentProps {
  /** Raw markdown string to render. */
  content: string;
}

/** Stable remark plugin list, hoisted to avoid re-creating on every render. */
const plugins = [remarkGfm];

/** Stable custom element renderers for react-markdown, hoisted to module scope. */
const components = {
  h1: ({ children }: { children?: React.ReactNode }) => <h1 className="text-xl font-bold mt-4 mb-2">{children}</h1>,
  h2: ({ children }: { children?: React.ReactNode }) => <h2 className="text-lg font-semibold mt-3 mb-2">{children}</h2>,
  h3: ({ children }: { children?: React.ReactNode }) => <h3 className="text-base font-semibold mt-2 mb-1">{children}</h3>,
  p: ({ children }: { children?: React.ReactNode }) => <p className="mb-2 leading-relaxed">{children}</p>,
  ul: ({ children }: { children?: React.ReactNode }) => <ul className="list-disc pl-5 mb-2 space-y-1">{children}</ul>,
  ol: ({ children }: { children?: React.ReactNode }) => <ol className="list-decimal pl-5 mb-2 space-y-1">{children}</ol>,
  li: ({ children }: { children?: React.ReactNode }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }: { children?: React.ReactNode }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }: { children?: React.ReactNode }) => <em className="italic">{children}</em>,
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
    const safeHref = href && /^https?:|^mailto:/.test(href) ? href : undefined;
    return (
      <a
        href={safeHref}
        className="text-primary underline hover:text-primary/80"
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    );
  },
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-l-2 border-border pl-3 my-2 text-muted-foreground italic">
      {children}
    </blockquote>
  ),
  pre: ({ children, node }: { children?: React.ReactNode; node?: Element }) => {
    const firstChild = node?.children?.[0];
    const langClass =
      firstChild?.type === "element"
        ? (((firstChild as Element).properties?.className as string[] | undefined)?.[0] ?? "")
        : "";
    const language = langClass.replace("language-", "");

    return (
      <div className="my-2 rounded-lg overflow-hidden border border-border">
        {language && (
          <div className="bg-muted/50 px-3 py-1 text-xs text-muted-foreground border-b border-border">
            {language}
          </div>
        )}
        <pre className="bg-muted/30 p-3 overflow-x-auto text-sm font-mono leading-relaxed [&_code]:bg-transparent [&_code]:p-0 [&_code]:rounded-none">
          {children}
        </pre>
      </div>
    );
  },
  code: ({ children }: { children?: React.ReactNode }) => (
    <code className="bg-muted rounded px-1.5 py-0.5 text-sm font-mono">
      {children}
    </code>
  ),
  hr: () => <hr className="my-4 border-border" />,
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="overflow-x-auto my-2">
      <table className="min-w-full border border-border rounded">{children}</table>
    </div>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border border-border bg-muted/50 px-3 py-1.5 text-left text-sm font-semibold">
      {children}
    </th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border border-border px-3 py-1.5 text-sm">{children}</td>
  ),
};

/** Renders a markdown string with GFM support. Memoized to skip re-renders when content is unchanged. */
export const MarkdownContent = memo(function MarkdownContent({ content }: MarkdownContentProps) {
  return (
    <ReactMarkdown remarkPlugins={plugins} components={components}>
      {content}
    </ReactMarkdown>
  );
});
