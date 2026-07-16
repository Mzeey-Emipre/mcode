import { lazy, memo, Suspense } from "react";
import ReactMarkdown, {
  type Components,
  type UrlTransform,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  CircleAlert,
  ChevronRight,
  Info,
  Lightbulb,
  MessageSquareWarning,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import { CodeBlock } from "@/components/chat/CodeBlock";
import { cn } from "@/lib/utils";
import { resolveCodeBlockLanguage } from "@/lib/resolve-code-block-language";
import {
  remarkGitHubAlerts,
  type GitHubAlertKind,
} from "@/lib/remark-github-alerts";
import { remarkGitHubDisclosures } from "@/lib/remark-github-disclosures";

interface RemoteMarkdownRendererProps {
  content: string;
}

const LazyMermaidBlock = lazy(() => import("@/components/chat/MermaidBlock"));

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

const GITHUB_ALERTS: Record<
  GitHubAlertKind,
  { label: string; icon: LucideIcon; className: string }
> = {
  note: {
    label: "Note",
    icon: Info,
    className: "border-border/60 bg-muted/15 text-muted-foreground",
  },
  tip: {
    label: "Tip",
    icon: Lightbulb,
    className: "border-emerald-500/25 bg-emerald-500/[0.035] text-emerald-400",
  },
  important: {
    label: "Important",
    icon: MessageSquareWarning,
    className: "border-primary/25 bg-primary/[0.035] text-primary",
  },
  warning: {
    label: "Warning",
    icon: CircleAlert,
    className: "border-amber-500/25 bg-amber-500/[0.035] text-amber-400",
  },
  caution: {
    label: "Caution",
    icon: ShieldAlert,
    className: "border-destructive/25 bg-destructive/[0.035] text-destructive",
  },
};

const REMOTE_MARKDOWN_COMPONENTS: Components = {
  a({ node: _node, href, children, ...props }) {
    const safeHref = safeHttpUrl(href);
    if (!safeHref) return <>{children}</>;
    return (
      <a {...props} href={safeHref} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  pre({ node: _node, children }) {
    return <>{children}</>;
  },
  code({ node: _node, className, children, ...props }) {
    const source = String(children);
    const rawFence = /language-(\S+)/.exec(className ?? "")?.[1] ?? "";
    const isBlock = rawFence !== "" || source.endsWith("\n");
    if (!isBlock) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }

    const code = source.replace(/\n$/, "");
    if (rawFence === "mermaid") {
      return (
        <Suspense
          fallback={
            <pre className="overflow-x-auto rounded-sm bg-muted/30 p-3 font-mono text-xs">
              <code>{code}</code>
            </pre>
          }
        >
          <LazyMermaidBlock code={code} isStreaming={false} />
        </Suspense>
      );
    }

    const { language, label } = resolveCodeBlockLanguage(rawFence, code);
    return (
      <div
        data-remote-code-block
        className={[
          "min-w-0",
          "[&_[data-code-block]>div]:overflow-x-hidden",
          "[&_[data-code-block]_pre]:!min-w-0",
          "[&_[data-code-block]_pre]:!w-full",
          "[&_[data-code-block]_pre]:!whitespace-pre-wrap",
          "[&_[data-code-block]_code]:break-words",
          "[&_[data-code-block]_code]:whitespace-pre-wrap",
        ].join(" ")}
      >
        <CodeBlock
          code={code}
          language={language}
          languageLabel={label}
          isStreaming={false}
        />
      </div>
    );
  },
  img() {
    return null;
  },
  details({ node: _node, children, ...props }) {
    return (
      <details
        {...props}
        className="group/disclosure my-3 overflow-hidden rounded-md border border-border/45 bg-background/25 [&>*:not(summary)]:mx-4 [&>*:not(summary)]:mb-3"
      >
        {children}
      </details>
    );
  },
  summary({ node: _node, children, ...props }) {
    return (
      <summary
        {...props}
        className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium text-foreground/90 transition-colors hover:bg-muted/20 [&::-webkit-details-marker]:hidden"
      >
        <ChevronRight
          size={13}
          aria-hidden
          className="shrink-0 text-muted-foreground transition-transform group-open/disclosure:rotate-90"
        />
        <span>{children}</span>
      </summary>
    );
  },
  blockquote({ node, children, ...props }) {
    const rawKind = node?.properties?.["data-github-alert"];
    const kind =
      typeof rawKind === "string" && rawKind in GITHUB_ALERTS
        ? (rawKind as GitHubAlertKind)
        : null;
    if (!kind) {
      return (
        <blockquote
          {...props}
          className="rounded-md border border-border/50 bg-muted/15 px-4 py-3 text-muted-foreground"
        >
          {children}
        </blockquote>
      );
    }

    const alert = GITHUB_ALERTS[kind];
    const AlertIcon = alert.icon;
    return (
      <aside
        role="note"
        aria-label={`${alert.label} alert`}
        data-github-alert={kind}
        className={cn("rounded-md border px-4 py-3", alert.className)}
      >
        <div className="flex items-center gap-2 text-xs font-semibold">
          <AlertIcon size={14} aria-hidden />
          <span>{alert.label}</span>
        </div>
        <div className="mt-3 space-y-3 text-foreground/90">{children}</div>
      </aside>
    );
  },
};

const REMARK_PLUGINS = [remarkGfm, remarkGitHubAlerts, remarkGitHubDisclosures];

/** Renders hostile provider Markdown without application-specific behaviors. */
const RemoteMarkdownRenderer = memo(function RemoteMarkdownRenderer({
  content,
}: RemoteMarkdownRendererProps) {
  return (
    <div
      className={[
        "space-y-4",
        "[&_h1]:mt-5 [&_h1]:border-b [&_h1]:border-border/50 [&_h1]:pb-2 [&_h1]:text-base [&_h1]:font-semibold",
        "[&_h2]:mt-5 [&_h2]:border-b [&_h2]:border-border/50 [&_h2]:pb-2 [&_h2]:text-base [&_h2]:font-semibold",
        "[&_h3]:mt-3 [&_h3]:text-sm [&_h3]:font-medium",
        "[&_ul]:space-y-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:space-y-1 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_li]:my-1",
        "[&_a]:text-link [&_a]:underline [&_a]:underline-offset-2",
        "[&_hr]:my-5 [&_hr]:border-border/50",
        "[&_code]:rounded-sm [&_code]:bg-muted/35 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs",
        "[&_[data-code-block]_code]:rounded-none [&_[data-code-block]_code]:bg-transparent [&_[data-code-block]_code]:p-0",
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
