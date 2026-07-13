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
  // Memoized and colon-replaced with "-" (not "") to prevent ID collisions between adjacent instances.
  const mermaidId = useMemo(() => "mermaid-" + rawId.replace(/:/g, "-"), [rawId]);
  const containerRef = useRef<HTMLDivElement>(null);
  const renderAttemptRef = useRef(0);

  const [state, setState] = useState<RenderState>({ status: "loading" });
  const [view, setView] = useState<"diagram" | "code">("diagram");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  // Render mermaid diagram
  useEffect(() => {
    if (isStreaming || !code.trim()) return;

    const attempt = ++renderAttemptRef.current;
    const renderId = `${mermaidId}-${attempt}`;
    let cancelled = false;
    setState({ status: "loading" });

    (async () => {
      try {
        await waitForLayout();
        if (cancelled) return;

        const container = containerRef.current;
        if (container) {
          await waitUntilVisible(container);
          if (cancelled) return;
        }

        const mermaid = await ensureInitialized(mermaidTheme);
        if (cancelled) return;

        // Validate first so invalid source never reaches the renderer.
        // mermaid.render appends a temp measurement node (#d<id>) to
        // document.body and does NOT clean it up on throw — validating
        // up front prevents those orphans from littering the page.
        const parseResult = await mermaid.parse(code, { suppressErrors: true });
        if (cancelled) return;
        if (!parseResult) {
          if (attempt === renderAttemptRef.current) {
            setState({ status: "error" });
          }
          return;
        }

        const { svg } = await mermaid.render(renderId, code);
        if (cancelled || attempt !== renderAttemptRef.current) return;
        setState({ status: "success", svg });
      } catch (err) {
        removeMermaidArtifacts(renderId);
        if (cancelled || attempt !== renderAttemptRef.current) return;
        console.error("[MermaidBlock] render failed:", err);
        setState({ status: "error" });
      }
    })();

    return () => {
      cancelled = true;
      removeMermaidArtifacts(renderId);
    };
  }, [code, mermaidTheme, isStreaming, mermaidId]);

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

  // Empty code - render nothing
  if (!code.trim()) return null;

  // Streaming - show raw code
  if (isStreaming) {
    return (
      <pre className="bg-muted text-foreground p-3 overflow-x-auto text-sm font-mono leading-relaxed rounded-lg">
        <code>{code}</code>
      </pre>
    );
  }

  // Error state - error banner + code view, no toggle
  if (state.status === "error") {
    return (
      <div className="my-2 rounded-lg overflow-hidden border border-border">
        <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-destructive bg-destructive/10 border-b border-destructive/20">
          Diagram could not be rendered
        </div>
        <div className="flex items-center justify-between bg-background px-3 py-1 border-b border-border">
          <span className="text-xs text-muted-foreground">mermaid</span>
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            aria-label={copied ? "Copied" : "Copy code"}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </div>
        <pre className="bg-muted text-foreground p-3 overflow-x-auto text-sm font-mono leading-relaxed">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  // Loading or success state
  return (
    <div ref={containerRef} className="my-2 rounded-lg overflow-hidden border border-border">
      {/* Header bar - solid bg-background matches diagram view, no transparency bleed in user bubble */}
      <div className="flex items-center justify-between bg-background px-3 py-1 border-b border-border">
        <span className="text-xs text-muted-foreground">mermaid</span>
        <div className="flex items-center gap-1">
          {state.status === "success" && (
            <button
              type="button"
              onClick={() => setView(view === "diagram" ? "code" : "diagram")}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              aria-label={view === "diagram" ? "View code" : "View diagram"}
            >
              {view === "diagram" ? <Code2 size={13} /> : <GitGraph size={13} />}
            </button>
          )}
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            aria-label={copied ? "Copied" : "Copy code"}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </div>
      </div>

      {/* Content area */}
      {state.status === "loading" && (
        <pre className="bg-muted text-foreground p-3 overflow-x-auto text-sm font-mono leading-relaxed">
          <code>{code}</code>
        </pre>
      )}
      {state.status === "success" && view === "diagram" && (
        <>
          <button
            type="button"
            aria-label="Open diagram preview"
            className={[
              "group/diagram block w-full cursor-zoom-in overflow-x-auto bg-background p-3 text-left",
              "outline-none transition-colors hover:bg-muted/15",
              "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              "motion-reduce:transition-none",
            ].join(" ")}
            onClick={() => setPreviewOpen(true)}
          >
            <span
              className="block min-w-fit [&_svg]:mx-auto"
              // SVG is sanitized by mermaid's bundled DOMPurify with securityLevel "strict"
              dangerouslySetInnerHTML={{ __html: state.svg }}
            />
          </button>
          <MermaidPreviewDialog
            open={previewOpen}
            onOpenChange={setPreviewOpen}
            svg={state.svg}
          />
        </>
      )}
      {state.status === "success" && view === "code" && (
        <pre className="bg-muted text-foreground p-3 overflow-x-auto text-sm font-mono leading-relaxed">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
});

export default MermaidBlock;
