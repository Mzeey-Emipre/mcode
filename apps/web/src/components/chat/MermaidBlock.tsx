import { memo, useState, useEffect, useCallback, useRef, useId, useMemo } from "react";
import { Copy, Check, Code2, GitGraph } from "lucide-react";
import { useShikiTheme } from "@/hooks/useTheme";
import { MermaidPreviewDialog } from "./MermaidPreviewDialog";

/** Props for {@link MermaidBlock}. */
interface MermaidBlockProps {
  /** Raw mermaid DSL source code. */
  code: string;
  /** When true, shows raw code instead of rendering the diagram. */
  isStreaming: boolean;
}

/** Tracks the mermaid render lifecycle: loading → success or error. */
type RenderState =
  | { status: "loading" }
  | { status: "success"; svg: string }
  | { status: "error" };

// Module-level mermaid loader - cached across all instances
let mermaidPromise: Promise<typeof import("mermaid")> | null = null;
let lastInitTheme: string | null = null;

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").catch((err) => {
      // Clear the cache so future attempts can retry instead of re-throwing permanently.
      mermaidPromise = null;
      throw err;
    });
  }
  return mermaidPromise;
}

async function ensureInitialized(theme: "dark" | "default") {
  const mermaidModule = await loadMermaid();
  const mermaid = mermaidModule.default;
  if (lastInitTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme,
    });
    lastInitTheme = theme;
  }
  return mermaid;
}

/**
 * Resets module-level mermaid state. Exported for use in tests only.
 * @internal
 */
export function __resetForTesting() {
  mermaidPromise = null;
  lastInitTheme = null;
}

/** Maps the app's Shiki theme to a mermaid theme. */
function toMermaidTheme(shikiTheme: string): "dark" | "default" {
  return shikiTheme === "github-dark" ? "dark" : "default";
}

/** Removes mermaid measurement/render nodes left on `document.body`. */
function removeMermaidArtifacts(renderId: string): void {
  document.getElementById(`d${renderId}`)?.remove();
  document.getElementById(renderId)?.remove();
}

/**
 * Waits for the next two animation frames so flex/scroll layout has settled.
 * Mermaid's layout math produces NaN transforms when render runs mid-reflow.
 */
function waitForLayout(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

/**
 * Waits until `element` is visible with non-zero width, or times out and proceeds.
 * Hidden tabs and rapid plan version swaps can otherwise measure zero-width boxes.
 */
function waitUntilVisible(element: HTMLElement, timeoutMs = 2_000): Promise<void> {
  if (typeof IntersectionObserver === "undefined") {
    return Promise.resolve();
  }

  const rect = element.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0 && element.offsetParent !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timeoutId);
      resolve();
    };

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && entry.intersectionRect.width > 0) {
          finish();
        }
      },
      { threshold: 0 },
    );
    observer.observe(element);

    const timeoutId = setTimeout(finish, timeoutMs);
  });
}

interface MermaidRenderRequest {
  code: string;
  mermaidTheme: "dark" | "default";
  renderId: string;
  container: HTMLDivElement | null;
  isCancelled: () => boolean;
}

async function renderMermaidDiagram({
  code,
  mermaidTheme,
  renderId,
  container,
  isCancelled,
}: MermaidRenderRequest): Promise<RenderState | null> {
  await waitForLayout();
  if (isCancelled()) return null;

  if (container) {
    await waitUntilVisible(container);
    if (isCancelled()) return null;
  }

  const mermaid = await ensureInitialized(mermaidTheme);
  if (isCancelled()) return null;

  const parseResult = await mermaid.parse(code, { suppressErrors: true });
  if (isCancelled()) return null;
  if (!parseResult) return { status: "error" };

  const { svg } = await mermaid.render(renderId, code);
  return isCancelled() ? null : { status: "success", svg };
}

function useMermaidRendering(
  code: string,
  isStreaming: boolean,
  mermaidTheme: "dark" | "default",
  mermaidId: string,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const renderAttemptRef = useRef(0);
  const [state, setState] = useState<RenderState>({ status: "loading" });

  useEffect(() => {
    if (isStreaming || !code.trim()) return;

    const attempt = ++renderAttemptRef.current;
    const renderId = `${mermaidId}-${attempt}`;
    let cancelled = false;
    const isCancelled = () => cancelled || attempt !== renderAttemptRef.current;
    setState({ status: "loading" });

    void renderMermaidDiagram({
      code,
      mermaidTheme,
      renderId,
      container: containerRef.current,
      isCancelled,
    }).then(
      (nextState) => {
        if (nextState && !isCancelled()) setState(nextState);
      },
      (error: unknown) => {
        removeMermaidArtifacts(renderId);
        if (isCancelled()) return;
        console.error("[MermaidBlock] render failed:", error);
        setState({ status: "error" });
      },
    );

    return () => {
      cancelled = true;
      removeMermaidArtifacts(renderId);
    };
  }, [code, mermaidTheme, isStreaming, mermaidId]);

  return { containerRef, state };
}

interface MermaidToolbarProps {
  copied: boolean;
  onCopy: () => void;
  view?: "diagram" | "code";
  onToggleView?: () => void;
}

function MermaidToolbar({ copied, onCopy, view, onToggleView }: MermaidToolbarProps) {
  const canToggleView = view !== undefined && onToggleView !== undefined;
  return (
    <div className="flex items-center justify-between bg-background px-3 py-1 border-b border-border">
      <span className="text-xs text-muted-foreground">mermaid</span>
      <div className="flex items-center gap-1">
        {canToggleView ? (
          <button
            type="button"
            onClick={onToggleView}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            aria-label={view === "diagram" ? "View code" : "View diagram"}
          >
            {view === "diagram" ? <Code2 size={13} /> : <GitGraph size={13} />}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onCopy}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          aria-label={copied ? "Copied" : "Copy code"}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
    </div>
  );
}

function MermaidCode({ code }: { code: string }) {
  return (
    <pre className="bg-muted text-foreground p-3 overflow-x-auto text-sm font-mono leading-relaxed">
      <code>{code}</code>
    </pre>
  );
}

function MermaidErrorBlock({ code, copied, onCopy }: { code: string } & Pick<MermaidToolbarProps, "copied" | "onCopy">) {
  return (
    <div className="my-2 rounded-lg overflow-hidden border border-border">
      <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-destructive bg-destructive/10 border-b border-destructive/20">
        Diagram could not be rendered
      </div>
      <MermaidToolbar copied={copied} onCopy={onCopy} />
      <MermaidCode code={code} />
    </div>
  );
}

interface MermaidReadyBlockProps extends Pick<MermaidToolbarProps, "copied" | "onCopy"> {
  code: string;
  state: Exclude<RenderState, { status: "error" }>;
  view: "diagram" | "code";
  onToggleView: () => void;
  onPreviewOpen: () => void;
  previewOpen: boolean;
  onPreviewChange: (open: boolean) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

function MermaidReadyContent({
  code,
  state,
  view,
  onPreviewOpen,
}: Pick<MermaidReadyBlockProps, "code" | "state" | "view" | "onPreviewOpen">) {
  if (state.status === "loading" || view === "code") return <MermaidCode code={code} />;
  return (
    <button
      type="button"
      aria-label="Open diagram preview"
      className={[
        "group/diagram block w-full cursor-zoom-in overflow-x-auto bg-background p-3 text-left",
        "outline-none transition-colors hover:bg-muted/15",
        "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        "motion-reduce:transition-none",
      ].join(" ")}
      onClick={onPreviewOpen}
    >
      <span
        className="block min-w-fit [&_svg]:mx-auto"
        // SVG is sanitized by mermaid's bundled DOMPurify with securityLevel "strict"
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
    </button>
  );
}

function MermaidReadyBlock({
  code,
  copied,
  onCopy,
  state,
  view,
  onToggleView,
  onPreviewOpen,
  previewOpen,
  onPreviewChange,
  containerRef,
}: MermaidReadyBlockProps) {
  return (
    <div ref={containerRef} className="my-2 rounded-lg overflow-hidden border border-border">
      <MermaidToolbar copied={copied} onCopy={onCopy} view={state.status === "success" ? view : undefined} onToggleView={state.status === "success" ? onToggleView : undefined} />
      <MermaidReadyContent code={code} state={state} view={view} onPreviewOpen={onPreviewOpen} />
      {state.status === "success" ? <MermaidPreviewDialog open={previewOpen} onOpenChange={onPreviewChange} svg={state.svg} /> : null}
    </div>
  );
}

interface MermaidBlockContentProps {
  code: string;
  isStreaming: boolean;
  state: RenderState;
  copied: boolean;
  onCopy: () => void;
  view: "diagram" | "code";
  onToggleView: () => void;
  previewOpen: boolean;
  onPreviewChange: (open: boolean) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

function MermaidBlockContent({
  code,
  isStreaming,
  state,
  copied,
  onCopy,
  view,
  onToggleView,
  previewOpen,
  onPreviewChange,
  containerRef,
}: MermaidBlockContentProps) {
  if (!code.trim()) return null;
  if (isStreaming) return <MermaidCode code={code} />;
  if (state.status === "error") return <MermaidErrorBlock code={code} copied={copied} onCopy={onCopy} />;

  return (
    <MermaidReadyBlock
      code={code}
      copied={copied}
      onCopy={onCopy}
      state={state}
      view={view}
      onToggleView={onToggleView}
      onPreviewOpen={() => onPreviewChange(true)}
      previewOpen={previewOpen}
      onPreviewChange={onPreviewChange}
      containerRef={containerRef}
    />
  );
}

/**
 * Renders a mermaid diagram from fenced code blocks.
 * Lazy-loads the mermaid library on first mount and caches it for subsequent blocks.
 * Supports diagram/code toggle, theme reactivity, and error fallback.
 *
 * SVG output uses dangerouslySetInnerHTML. This is safe because mermaid v10+
 * sanitizes SVG via its bundled DOMPurify, and securityLevel is set to "strict".
 */
const MermaidBlock = memo(function MermaidBlock({ code, isStreaming }: MermaidBlockProps) {
  const shikiTheme = useShikiTheme();
  const mermaidTheme = toMermaidTheme(shikiTheme);
  const rawId = useId();
  const mermaidId = useMemo(() => "mermaid-" + rawId.replace(/:/g, "-"), [rawId]);
  const { containerRef, state } = useMermaidRendering(code, isStreaming, mermaidTheme, mermaidId);
  const [view, setView] = useState<"diagram" | "code">("diagram");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard write failed - silently ignore
    }
  }, [code]);

  return (
    <MermaidBlockContent
      code={code}
      isStreaming={isStreaming}
      state={state}
      copied={copied}
      onCopy={handleCopy}
      view={view}
      onToggleView={() => setView(view === "diagram" ? "code" : "diagram")}
      previewOpen={previewOpen}
      onPreviewChange={setPreviewOpen}
      containerRef={containerRef}
    />
  );
});

export default MermaidBlock;
