import { memo } from "react";
import ReactMarkdown, {
  type Components,
  type UrlTransform,
} from "react-markdown";
import remarkGfm from "remark-gfm";

interface RemoteMarkdownRendererProps {
  content: string;
}

function safeHttpUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

const remoteUrlTransform: UrlTransform = (value, key) =>
  key === "href" ? safeHttpUrl(value) : null;

const REMOTE_MARKDOWN_COMPONENTS: Components = {
  a({ node: _node, href, children, ...props }) {
    const safeHref = safeHttpUrl(href);
    if (!safeHref) return <>{children}</>;
    return (
      <a
        {...props}
        href={safeHref}
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    );
  },
  code({ node: _node, children, ...props }) {
    return <code {...props}>{children}</code>;
  },
  img() {
    return null;
  },
};

const REMARK_PLUGINS = [remarkGfm];

/** Renders hostile provider Markdown without application-specific behaviors. */
const RemoteMarkdownRenderer = memo(function RemoteMarkdownRenderer({
  content,
}: RemoteMarkdownRendererProps) {
  return (
    <div
      className={[
        "space-y-3",
        "[&_h1]:mt-4 [&_h1]:text-base [&_h1]:font-semibold",
        "[&_h2]:mt-4 [&_h2]:text-sm [&_h2]:font-semibold",
        "[&_h3]:mt-3 [&_h3]:text-sm [&_h3]:font-medium",
        "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_li]:my-1",
        "[&_a]:text-link [&_a]:underline [&_a]:underline-offset-2",
        "[&_blockquote]:bg-muted/20 [&_blockquote]:px-3 [&_blockquote]:py-1 [&_blockquote]:text-muted-foreground",
        "[&_pre]:overflow-x-auto [&_pre]:rounded-sm [&_pre]:bg-muted/30 [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-xs",
        "[&_code]:rounded-sm [&_code]:bg-muted/35 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs",
        "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
        "[&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:border-collapse",
        "[&_th]:border [&_th]:border-border/40 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left",
        "[&_td]:border [&_td]:border-border/40 [&_td]:px-2 [&_td]:py-1",
      ].join(" ")}
    >
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={REMOTE_MARKDOWN_COMPONENTS}
        urlTransform={remoteUrlTransform}
        skipHtml
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

RemoteMarkdownRenderer.displayName = "RemoteMarkdownRenderer";

export default RemoteMarkdownRenderer;
