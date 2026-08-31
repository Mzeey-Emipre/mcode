import { memo, useMemo, lazy, Suspense } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { ExternalLink, Globe } from "lucide-react";
import {
  isMcodeWorkspacePreviewUrl,
  mcodeWorkspacePreviewHref,
  looksLikeWorkspaceRelativeFileRef,
} from "@mcode/contracts";
import { CodeBlock } from "./CodeBlock";
import { FileTypeIcon } from "@/components/ui/file-type-icon";
import { SiteFavicon } from "@/components/ui/favicon";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { resolveCodeBlockLanguage } from "@/lib/resolve-code-block-language";
import { isMac } from "@/lib/platform";
import {
  isModifierClick,
  isPreviewableUrl,
  openUrlInPreview,
} from "@/features/preview/navigation/open-url-in-preview";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { EntityToken, type EntityKind } from "./EntityToken";

/** Pass through workspace preview URLs; otherwise use react-markdown's default sanitizer. */
function markdownUrlTransform(value: string): string {
  const trimmed = value.trim();
  if (isPreviewableUrl(trimmed)) return trimmed;
  return defaultUrlTransform(value);
}

/** Props for {@link MarkdownContent}. */
interface MarkdownContentProps {
  /** Raw markdown string to render. */
  content: string;
  /** When true, code blocks skip syntax highlighting. Defaults to false. */
  isStreaming?: boolean;
  /**
   * Controls prose styling. 'user' adapts colors for the accent-surfaced user bubble.
   * Defaults to 'assistant'.
   */
  variant?: "assistant" | "user";
  /** Optional react-markdown component overrides merged on top of defaults. */
  componentOverrides?: Partial<Components>;
  /** Thread that owns the rendered Markdown. */
  threadId?: string | null;
  /** Uses the chat coordinator for settled assistant Markdown. */
  chatHighlighting?: boolean;
}

/** GFM for assistant bubbles; user bubbles also enable single-newline line breaks. */
const ASSISTANT_REMARK_PLUGINS = [remarkGfm];
const USER_REMARK_PLUGINS = [remarkGfm, remarkBreaks];

/** Lazy-loaded MermaidBlock - only fetched when a mermaid fence is encountered. */
const LazyMermaidBlock = lazy(() => import("./MermaidBlock"));

/** Matches a standalone HTTP(S) URL (used to detect URLs inside inline code spans). */
const HTTP_URL_RE = /^https?:\/\/\S+$/;

/** Schemes that should keep site-style link chrome rather than file chrome. */
const EXTERNAL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/** Common basename shape for a file reference shown in Markdown. */
const FILE_BASENAME_RE = /^[^/\\]+\.[A-Za-z0-9][A-Za-z0-9-]*$/;

/** Explicit inline-code syntax that safely identifies an app-side entity. */
function resolveInlineEntity(value: string): { kind: EntityKind; label: string } | null {
  if (/^\$[a-z][a-z0-9_-]*$/i.test(value)) {
    return { kind: "skill", label: value };
  }
  if (/^(?:plugin:|plugin\/)[a-z][a-z0-9:_-]*$/i.test(value)) {
    return { kind: "plugin", label: value };
  }
  if (/^@[a-z][a-z0-9_-]*$/i.test(value)) {
    return { kind: "agent", label: value };
  }
  if (/^\/m:[a-z][a-z0-9:_-]*$/i.test(value)) {
    return { kind: "mcode", label: value };
  }
  if (/^\/[a-z][a-z0-9:_-]*$/i.test(value)) {
    return { kind: "command", label: value };
  }
  return null;
}

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

function resolveMarkdownHref(href: string | undefined, workspacePath: string | null): string | undefined {
  if (!href) return undefined;
  const raw = href.trim();
  if (workspacePath && looksLikeWorkspaceRelativeFileRef(raw)) {
    return mcodeWorkspacePreviewHref(raw);
  }
  if (isPreviewableUrl(raw)) return raw;

  try {
    const { protocol } = new URL(raw);
    if (protocol === "mailto:") {
      return raw;
    }
  } catch {
    /* invalid URL */
  }
  return undefined;
}

/**
 * Produces a compact, human-readable label for a bare URL so inline links read
 * like the Overview repository row (`owner/repo`) instead of a raw `https://`
 * string. GitHub repos collapse to `owner/repo`, issues and pull requests to
 * `owner/repo#123`, commits to `owner/repo@shortsha`; every other URL drops the
 * protocol and a leading `www.`, keeping `host/path`. Only used when the link's
 * visible text is the URL itself; authored link text is never rewritten.
 */
function formatBareUrlLabel(rawHref: string): string {
  try {
    const url = new URL(rawHref);
    const host = url.hostname.replace(/^www\./, "");
    const path = url.pathname.replace(/\/+$/, "");
    const segments = path.split("/").filter(Boolean);

    if (host === "github.com" && segments.length >= 2) {
      const ownerRepo = `${segments[0]}/${segments[1]}`;
      if (segments.length >= 4 && (segments[2] === "issues" || segments[2] === "pull")) {
        return `${ownerRepo}#${segments[3]}`;
      }
      if (segments.length >= 4 && segments[2] === "commit") {
        return `${ownerRepo}@${segments[3].slice(0, 7)}`;
      }
      return ownerRepo;
    }

    return path ? `${host}${path}` : host;
  } catch {
    return rawHref;
  }
}

/** Extracts plain text from link children when it is a single string node. */
function getPlainTextChild(children: React.ReactNode): string | null {
  if (typeof children === "string") return children;
  if (Array.isArray(children) && children.length === 1 && typeof children[0] === "string") {
    return children[0];
  }
  return null;
}

function getLinkFaviconUrl(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== "https:") return null;
    return `${url.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

function workspacePreviewPath(href: string): string | null {
  if (!isMcodeWorkspacePreviewUrl(href)) return null;
  try {
    const url = new URL(href);
    return decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  } catch {
    return null;
  }
}

function looksLikeDisplayFileRef(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim().replace(/^<|>$/g, "");
  if (!trimmed) return false;
  if (isMcodeWorkspacePreviewUrl(trimmed)) return true;
  if (EXTERNAL_SCHEME_RE.test(trimmed)) return false;

  const normalized = trimmed.replace(/\\/g, "/");
  const basename = normalized.split("/").filter(Boolean).at(-1) ?? normalized;
  if (!FILE_BASENAME_RE.test(basename)) return false;
  return normalized.includes("/") || normalized.startsWith(".") || trimmed.startsWith("/");
}

function getMarkdownFileIconPath(args: {
  href: string | undefined;
  safeHref: string | undefined;
  childText: string | null;
}): string | null {
  const previewPath = args.safeHref ? workspacePreviewPath(args.safeHref) : null;
  if (previewPath) return previewPath;

  if (looksLikeDisplayFileRef(args.href)) return args.href!.trim().replace(/^<|>$/g, "");
  if (looksLikeDisplayFileRef(args.childText ?? undefined)) return args.childText!.trim();
  return null;
}

interface MarkdownLinkProps {
  href?: string;
  children?: React.ReactNode;
  workspacePath: string | null;
}

interface MarkdownLinkAnchorProps {
  safeHref: string | undefined;
  isPreviewable: boolean;
  faviconUrl: string | null;
  fileIconPath: string | null;
  label: React.ReactNode;
}

function handleMarkdownAnchorClick(
  event: React.MouseEvent<HTMLAnchorElement>,
  safeHref: string | undefined,
  isPreviewable: boolean,
): void {
  if (!safeHref) return;
  if (isPreviewable) {
    handleLinkClick(event, safeHref);
    return;
  }

  event.preventDefault();
  if (window.desktopBridge?.openExternalUrl) {
    void window.desktopBridge.openExternalUrl(safeHref);
    return;
  }
  window.open(safeHref, "_blank", "noopener,noreferrer");
}

function MarkdownLinkAnchor({
  safeHref,
  isPreviewable,
  faviconUrl,
  fileIconPath,
  label,
}: MarkdownLinkAnchorProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={safeHref}
            className="inline-flex max-w-full items-center gap-1 align-baseline text-primary no-underline transition-colors hover:underline"
            target="_blank"
            rel="noopener noreferrer"
            data-testid="markdown-link"
            onClick={(event) => handleMarkdownAnchorClick(event, safeHref, isPreviewable)}
          >
            {fileIconPath ? (
              <span data-testid="markdown-link-file-icon" className="inline-flex shrink-0">
                <FileTypeIcon filePath={fileIconPath} size={13} />
              </span>
            ) : (
              <SiteFavicon
                src={faviconUrl}
                fallback={<Globe size={12} aria-hidden className="shrink-0 text-muted-foreground" />}
                frameTestId="markdown-link-favicon-frame"
                imageTestId="markdown-link-favicon"
              />
            )}
            <span className="min-w-0 truncate">{label}</span>
            {safeHref ? <ExternalLink size={12} aria-hidden className="shrink-0 text-muted-foreground" /> : null}
          </a>
        }
      />
      <TooltipContent>{safeHref}</TooltipContent>
    </Tooltip>
  );
}

function MarkdownLink({
  href,
  children,
  workspacePath,
}: MarkdownLinkProps) {
  const safeHref = resolveMarkdownHref(href, workspacePath);
  const isPreviewable = !!safeHref && isPreviewableUrl(safeHref);
  const showHint = isPreviewable && hasPreview();
  const faviconUrl = getLinkFaviconUrl(safeHref);
  const childText = getPlainTextChild(children);
  const fileIconPath = getMarkdownFileIconPath({ href, safeHref, childText });
  const isBareUrlText =
    !!childText && !!safeHref && (childText === href || childText === safeHref || HTTP_URL_RE.test(childText.trim()));
  const label = isBareUrlText && safeHref ? formatBareUrlLabel(safeHref) : children;
  const anchor = (
    <MarkdownLinkAnchor
      safeHref={safeHref}
      isPreviewable={isPreviewable}
      faviconUrl={faviconUrl}
      fileIconPath={fileIconPath}
      label={label}
    />
  );

  if (!showHint) return anchor;
  return (
    <Tooltip>
      <TooltipTrigger render={anchor} />
      <TooltipContent side="top" className="text-xs">{previewHint}</TooltipContent>
    </Tooltip>
  );
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
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
      <MarkdownLink href={href} workspacePath={workspacePath}>
        {children}
      </MarkdownLink>
    ),
    blockquote: ({ children }: { children?: React.ReactNode }) => (
      <blockquote className="border-l-2 border-border pl-3 my-2 text-muted-foreground italic">
        {children}
      </blockquote>
    ),
    pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    hr: () => <hr className="my-4 border-border" />,
    table: ({ children }: { children?: React.ReactNode }) => (
      <div className="overflow-x-auto my-2">
        <table className="min-w-full border border-border rounded">{children}</table>
      </div>
    ),
    th: ({ children }: { children?: React.ReactNode }) => (
      <th
        className={
          isUser
            ? "border border-border bg-foreground/10 px-3 py-1.5 text-left text-sm font-semibold"
            : "border border-border bg-muted/50 px-3 py-1.5 text-left text-sm font-semibold"
        }
      >
        {children}
      </th>
    ),
    td: ({ children }: { children?: React.ReactNode }) => (
      <td className="border border-border px-3 py-1.5 text-sm">{children}</td>
    ),
  };
}

interface MarkdownCodeProps {
  children?: React.ReactNode;
  className?: string;
  isStreaming: boolean;
  variant: "assistant" | "user";
  workspacePath: string | null;
  threadId: string | null;
  chatHighlighting: boolean;
}

interface InlineMarkdownCodeProps {
  children?: React.ReactNode;
  rawContent: string;
  isUser: boolean;
  workspacePath: string | null;
}

function PreviewHint({ children }: { children: React.ReactElement }) {
  if (!hasPreview()) return children;
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="top" className="text-xs">{previewHint}</TooltipContent>
    </Tooltip>
  );
}

function InlineUrlCode({ children, text, codeClass }: { children?: React.ReactNode; text: string; codeClass: string }) {
  const code = (
    <code
      role="link"
      tabIndex={0}
      className={`${codeClass} text-link underline decoration-dotted hover:opacity-80 cursor-pointer whitespace-nowrap`}
      onClick={(event) => handleLinkClick(event, text)}
      onKeyDown={(event) => { if (event.key === "Enter") handleLinkClick(event, text); }}
    >
      {children}
    </code>
  );
  return <PreviewHint>{code}</PreviewHint>;
}

function InlineWorkspaceFileCode({
  text,
  previewUrl,
  isUser,
}: {
  text: string;
  previewUrl: string;
  isUser: boolean;
}) {
  const file = (
    <EntityToken
      kind="file"
      label={text}
      filePath={text}
      tone={isUser ? "user" : "assistant"}
      role="link"
      tabIndex={0}
      className="cursor-pointer text-link hover:underline focus-visible:outline-none focus-visible:ring-ring"
      onClick={(event) => handleLinkClick(event, previewUrl)}
      onKeyDown={(event) => { if (event.key === "Enter") handleLinkClick(event, previewUrl); }}
    />
  );
  return <PreviewHint>{file}</PreviewHint>;
}

function InlineMarkdownCode({ children, rawContent, isUser, workspacePath }: InlineMarkdownCodeProps) {
  const codeClass = isUser
    ? "bg-foreground/10 rounded px-1.5 py-0.5 text-sm font-mono"
    : "bg-muted rounded px-1.5 py-0.5 text-sm font-mono";
  const text = rawContent.trim();

  if (HTTP_URL_RE.test(text)) return <InlineUrlCode codeClass={codeClass} text={text}>{children}</InlineUrlCode>;

  const inlineEntity = resolveInlineEntity(text);
  if (inlineEntity) {
    return <EntityToken kind={inlineEntity.kind} label={inlineEntity.label} tone={isUser ? "user" : "assistant"} />;
  }

  if (workspacePath && looksLikeWorkspaceRelativeFileRef(text)) {
    return <InlineWorkspaceFileCode text={text} previewUrl={mcodeWorkspacePreviewHref(text)} isUser={isUser} />;
  }

  if (looksLikeWorkspaceRelativeFileRef(text)) {
    return <EntityToken kind="file" label={text} filePath={text} tone={isUser ? "user" : "assistant"} />;
  }

  return <code className={codeClass}>{children}</code>;
}

function FencedMarkdownCode({
  children,
  className,
  isStreaming,
  isUser,
  threadId,
  chatHighlighting,
}: Omit<MarkdownCodeProps, "variant" | "workspacePath"> & { isUser: boolean }) {
  const langMatch = className?.match(/language-(\S+)/);
  const rawFence = langMatch ? langMatch[1] : "";
  if (rawFence === "plan-questions" || rawFence === "plan-output") return null;

  const code = String(children).replace(/\n$/, "");
  if (rawFence === "mermaid") {
    return (
      <Suspense fallback={<pre className="bg-muted/30 rounded-lg p-4 overflow-x-auto"><code>{code}</code></pre>}>
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
      threadId={threadId}
      chatHighlighting={chatHighlighting && !isUser}
    />
  );
}

function MarkdownCode({
  children,
  className,
  isStreaming,
  variant,
  workspacePath,
  threadId,
  chatHighlighting,
}: MarkdownCodeProps) {
  const rawContent = String(children);
  const isInline = !className && !rawContent.includes("\n");
  if (isInline) {
    return <InlineMarkdownCode children={children} rawContent={rawContent} isUser={variant === "user"} workspacePath={workspacePath} />;
  }
  return <FencedMarkdownCode children={children} className={className} isStreaming={isStreaming} isUser={variant === "user"} threadId={threadId} chatHighlighting={chatHighlighting} />;
}

/**
 * Builds the `code` override that depends on `isStreaming`, `variant`, and workspace path.
 * Only recreated when those props change; static overrides are reused.
 */
function makeComponents(
  isStreaming: boolean,
  variant: "assistant" | "user",
  workspacePath: string | null,
  threadId: string | null,
  chatHighlighting: boolean,
  componentOverrides?: Partial<Components>,
) {
  const codeRenderer = ({ children, className }: { children?: React.ReactNode; className?: string }) => {
    return (
      <MarkdownCode
        children={children}
        className={className}
        isStreaming={isStreaming}
        variant={variant}
        workspacePath={workspacePath}
        threadId={threadId}
        chatHighlighting={chatHighlighting}
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
  threadId,
  chatHighlighting = false,
}: MarkdownContentProps) {
  const workspacePath = useWorkspaceStore((s) => {
    const id = s.activeWorkspaceId;
    if (!id) return null;
    return s.workspaces.find((w) => w.id === id)?.path ?? null;
  });
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const highlightThreadId = chatHighlighting
    ? (threadId === undefined ? activeThreadId : threadId)
    : threadId ?? null;

  const components = useMemo(
    () => makeComponents(isStreaming, variant, workspacePath, highlightThreadId, chatHighlighting, componentOverrides),
    [isStreaming, variant, workspacePath, highlightThreadId, chatHighlighting, componentOverrides],
  );

  const remarkPlugins = variant === "user" ? USER_REMARK_PLUGINS : ASSISTANT_REMARK_PLUGINS;

  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} components={components} urlTransform={markdownUrlTransform}>
      {content}
    </ReactMarkdown>
  );
});

export default MarkdownContent;
