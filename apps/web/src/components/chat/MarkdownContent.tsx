import { memo, useMemo, lazy, Suspense } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import {
  isMcodeWorkspacePreviewUrl,
  mcodeWorkspacePreviewHref,
  looksLikeWorkspaceRelativeFileRef,
} from "@mcode/contracts";
import { CodeBlock } from "./CodeBlock";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { resolveCodeBlockLanguage } from "@/lib/resolve-code-block-language";
import { isMac } from "@/lib/platform";
import {
  isModifierClick,
  isPreviewableUrl,
  openUrlInPreview,
} from "@/lib/open-url-in-preview";
import { useWorkspaceStore } from "@/stores/workspaceStore";

/** Pass through workspace preview URLs; otherwise use react-markdown's default sanitizer. */
function markdownUrlTransform(value: string): string {
  const trimmed = value.trim();
  if (isMcodeWorkspacePreviewUrl(trimmed)) return trimmed;
  return defaultUrlTransform(value);
}

/** Props for {@link MarkdownContent}. */
interface MarkdownContentProps {
  /** Raw markdown string to render. */
  content: string;
  /** When true, code blocks skip syntax highlighting. Defaults to false. */
  isStreaming?: boolean;
  /**
   * Controls prose styling. 'user' adapts colors for the primary-colored user bubble.
   * Defaults to 'assistant'.
   */
  variant?: "assistant" | "user";
  /** Optional react-markdown component overrides merged on top of defaults. */
  componentOverrides?: Partial<Components>;
}

/** GFM for assistant bubbles; user bubbles also enable single-newline line breaks. */
const ASSISTANT_REMARK_PLUGINS = [remarkGfm];
const USER_REMARK_PLUGINS = [remarkGfm, remarkBreaks];

/** Lazy-loaded MermaidBlock - only fetched when a mermaid fence is encountered. */
const LazyMermaidBlock = lazy(() => import("./MermaidBlock"));

/** Matches a standalone HTTP(S) URL (used to detect URLs inside inline code spans). */
const HTTP_URL_RE = /^https?:\/\/\S+$/;

/** Tooltip label for the Ctrl/Cmd+click preview hint. */
const previewHint = `${isMac ? "\u2318" : "Ctrl"}+click to open in preview`;

/** Whether the desktop preview bridge is available. */
function hasPreview(): boolean {
  return !!window.desktopBridge?.preview;
}

/** Active workspace path for resolving preview URLs. */
function getActiveWorkspacePath(): string | null {
  const { activeWorkspaceId, workspaces } = useWorkspaceStore.getState();
  if (!activeWorkspaceId) return null;
  return workspaces.find((w) => w.id === activeWorkspaceId)?.path ?? null;
}

/**
 * Handles a click on a previewable URL. Ctrl/Cmd+click opens in a new embedded
 * preview tab when available; a normal click opens in the system default browser.
 */
function handleLinkClick(e: React.MouseEvent | React.KeyboardEvent, url: string): void {
  e.preventDefault();

  const workspacePath = getActiveWorkspacePath();

  if (isModifierClick(e) && hasPreview()) {
    const threadId = useWorkspaceStore.getState().activeThreadId;
    if (threadId) {
      openUrlInPreview({ url, threadId, workspacePath });
      return;
    }
  }

  if (window.desktopBridge?.openExternalUrl) {
    if (isMcodeWorkspacePreviewUrl(url)) {
      void window.desktopBridge.openExternalUrl(url, workspacePath ?? null);
    } else {
      void window.desktopBridge.openExternalUrl(url);
    }
  } else if (!isMcodeWorkspacePreviewUrl(url)) {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/**
 * Builds the static component overrides that depend on `variant` and workspace context.
 * Elements whose colors differ between assistant and user bubble are variant-conditional.
 */
function makeStaticComponents(variant: "assistant" | "user", workspacePath: string | null) {
  const isUser = variant === "user";

  return {
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
      let safeHref: string | undefined;
      if (href) {
        const raw = href.trim();
        if (isMcodeWorkspacePreviewUrl(raw)) {
          safeHref = raw;
        } else if (workspacePath && looksLikeWorkspaceRelativeFileRef(raw)) {
          safeHref = mcodeWorkspacePreviewHref(raw);
        } else try {
          const { protocol } = new URL(href);
          if (protocol === "https:" || protocol === "http:" || protocol === "mailto:") {
            safeHref = href;
          }
        } catch {
          /* invalid URL */
        }
      }
      const linkClass = isUser
        ? "text-primary-foreground underline hover:opacity-80"
        : "text-primary underline hover:text-primary";
      const isPreviewable = !!safeHref && isPreviewableUrl(safeHref);
      const showHint = isPreviewable && hasPreview();
      const anchor = (
        <a
          href={safeHref}
          className={linkClass}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => {
            if (!safeHref) return;
            if (isPreviewable) return handleLinkClick(e, safeHref);
            e.preventDefault();
            if (window.desktopBridge?.openExternalUrl) {
              void window.desktopBridge.openExternalUrl(safeHref);
            } else {
              window.open(safeHref, "_blank", "noopener,noreferrer");
            }
          }}
        >
          {children}
        </a>
      );
      if (!showHint) return anchor;
      return (
        <Tooltip>
          <TooltipTrigger render={anchor} />
          <TooltipContent side="top" className="text-xs">{previewHint}</TooltipContent>
        </Tooltip>
      );
    },
    blockquote: ({ children }: { children?: React.ReactNode }) => (
      <blockquote
        className={
          isUser
            ? "border-l-2 pl-3 my-2 italic border-primary-foreground/40 text-primary-foreground/80"
            : "border-l-2 border-border pl-3 my-2 text-muted-foreground italic"
        }
      >
        {children}
      </blockquote>
    ),
    pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    hr: () => (
      <hr className={isUser ? "my-4 border-primary-foreground/20" : "my-4 border-border"} />
    ),
    table: ({ children }: { children?: React.ReactNode }) => (
      <div className="overflow-x-auto my-2">
        <table
          className={
            isUser
              ? "min-w-full border rounded border-primary-foreground/20"
              : "min-w-full border border-border rounded"
          }
        >
          {children}
        </table>
      </div>
    ),
    th: ({ children }: { children?: React.ReactNode }) => (
      <th
        className={
          isUser
            ? "border border-primary-foreground/20 bg-primary-foreground/10 px-3 py-1.5 text-left text-sm font-semibold"
            : "border border-border bg-muted/50 px-3 py-1.5 text-left text-sm font-semibold"
        }
      >
        {children}
      </th>
    ),
    td: ({ children }: { children?: React.ReactNode }) => (
      <td
        className={
          isUser
            ? "border border-primary-foreground/20 px-3 py-1.5 text-sm"
            : "border border-border px-3 py-1.5 text-sm"
        }
      >
        {children}
      </td>
    ),
  };
}

/**
 * Builds the `code` override that depends on `isStreaming`, `variant`, and workspace path.
 * Only recreated when those props change; static overrides are reused.
 */
function makeComponents(
  isStreaming: boolean,
  variant: "assistant" | "user",
  workspacePath: string | null,
  componentOverrides?: Partial<Components>,
) {
  const isUser = variant === "user";
  const codeRenderer = ({ children, className }: { children?: React.ReactNode; className?: string }) => {
      // Detect inline vs block code. In react-markdown's HAST, fenced code
      // blocks are wrapped in a <pre> parent (even without a language tag).
      // Fenced blocks always have a trailing newline from the code fence.
      // Check BEFORE stripping the trailing newline so even single-line
      // fenced blocks without a language are detected.
      const rawContent = String(children);
      const isInline = !className && !rawContent.includes("\n");

      if (isInline) {
        const codeClass = isUser
          ? "bg-primary-foreground/15 rounded px-1.5 py-0.5 text-sm font-mono"
          : "bg-muted rounded px-1.5 py-0.5 text-sm font-mono";

        // Detect URLs inside inline code and make them clickable
        const text = rawContent.trim();
        if (HTTP_URL_RE.test(text)) {
          const linkClass = isUser
            ? "text-primary-foreground underline decoration-dotted hover:opacity-80 cursor-pointer"
            : "text-primary underline decoration-dotted hover:text-primary cursor-pointer";
          const codeEl = (
            <code
              role="link"
              tabIndex={0}
              className={`${codeClass} ${linkClass} whitespace-nowrap`}
              onClick={(e) => handleLinkClick(e, text)}
              onKeyDown={(e) => { if (e.key === "Enter") handleLinkClick(e, text); }}
            >
              {children}
            </code>
          );
          if (!hasPreview()) return codeEl;
          return (
            <Tooltip>
              <TooltipTrigger render={codeEl} />
              <TooltipContent side="top" className="text-xs">{previewHint}</TooltipContent>
            </Tooltip>
          );
        }

        if (workspacePath && looksLikeWorkspaceRelativeFileRef(text)) {
          const previewUrl = mcodeWorkspacePreviewHref(text);
          const linkClass = isUser
            ? "text-primary-foreground underline decoration-dotted hover:opacity-80 cursor-pointer"
            : "text-primary underline decoration-dotted hover:text-primary cursor-pointer";
          const codeEl = (
            <code
              role="link"
              tabIndex={0}
              className={`${codeClass} ${linkClass} whitespace-nowrap`}
              onClick={(e) => handleLinkClick(e, previewUrl)}
              onKeyDown={(e) => { if (e.key === "Enter") handleLinkClick(e, previewUrl); }}
            >
              {children}
            </code>
          );
          if (!hasPreview()) return codeEl;
          return (
            <Tooltip>
              <TooltipTrigger render={codeEl} />
              <TooltipContent side="top" className="text-xs">{previewHint}</TooltipContent>
            </Tooltip>
          );
        }

        return <code className={codeClass}>{children}</code>;
      }

      const langMatch = className?.match(/language-(\S+)/);
      const rawFence = langMatch ? langMatch[1] : "";

      // Suppress fenced blocks the model emits for plan mode. The wizard
      // renders questions from the parsed payload, and plan-output is
      // displayed as a card / in the Scope panel, not as raw markdown.
      if (rawFence === "plan-questions" || rawFence === "plan-output") return null;

      const code = String(children).replace(/\n$/, "");

      if (rawFence === "mermaid") {
        return (
          <Suspense fallback={
            <pre className="bg-muted/30 rounded-lg p-4 overflow-x-auto"><code>{code}</code></pre>
          }>
            <LazyMermaidBlock code={code} isStreaming={isStreaming} />
          </Suspense>
        );
      }

      const { language, label } = resolveCodeBlockLanguage(rawFence, code);

      return (
        <CodeBlock
          code={code}
          language={language}
          languageLabel={label}
          isStreaming={isStreaming}
          disableHighlighting={isUser}
        />
      );
  };

  return {
    ...makeStaticComponents(variant, workspacePath),
    ...componentOverrides,
    code: codeRenderer,
  };
}

/** Renders a markdown string with GFM support. Memoized to skip re-renders when content is unchanged. */
export const MarkdownContent = memo(function MarkdownContent({
  content,
  isStreaming = false,
  variant = "assistant",
  componentOverrides,
}: MarkdownContentProps) {
  const workspacePath = useWorkspaceStore((s) => {
    const id = s.activeWorkspaceId;
    if (!id) return null;
    return s.workspaces.find((w) => w.id === id)?.path ?? null;
  });

  const components = useMemo(
    () => makeComponents(isStreaming, variant, workspacePath, componentOverrides),
    [isStreaming, variant, workspacePath, componentOverrides],
  );

  const remarkPlugins = variant === "user" ? USER_REMARK_PLUGINS : ASSISTANT_REMARK_PLUGINS;

  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} components={components} urlTransform={markdownUrlTransform}>
      {content}
    </ReactMarkdown>
  );
});

export default MarkdownContent;
