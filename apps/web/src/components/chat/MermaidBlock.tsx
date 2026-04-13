import { memo, useState, useEffect, useCallback, useRef, useId, useMemo } from "react";
import { Copy, Check, Code2, GitGraph } from "lucide-react";
import { useShikiTheme } from "@/hooks/useTheme";
import { CodeBlock } from "./CodeBlock";

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
    mermaidPromise = import("mermaid");
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

  const [state, setState] = useState<RenderState>({ status: "loading" });
  const [view, setView] = useState<"diagram" | "code">("diagram");
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

    let cancelled = false;
    setState({ status: "loading" });

    (async () => {
      try {
        const mermaid = await ensureInitialized(mermaidTheme);
        const { svg } = await mermaid.render(mermaidId, code);
        if (!cancelled) {
          setState({ status: "success", svg });
        }
      } catch (err) {
        console.error("[MermaidBlock] render failed:", err);
        if (!cancelled) {
          setState({ status: "error" });
        }
      }
    })();

    return () => {
      cancelled = true;
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
      <pre className="bg-muted/30 p-3 overflow-x-auto text-sm font-mono leading-relaxed rounded-lg">
        <code>{code}</code>
      </pre>
    );
  }

  // Error state - CodeBlock with error banner, no toggle
  if (state.status === "error") {
    return (
      <div>
        <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-destructive bg-destructive/10 rounded-t-lg border border-b-0 border-destructive/20">
          Diagram could not be rendered
        </div>
        <CodeBlock code={code} language="mermaid" isStreaming={false} />
      </div>
    );
  }

  // Loading or success state
  return (
    <div className="my-2 rounded-lg overflow-hidden border border-border">
      {/* Header bar - matches CodeBlock layout */}
      <div className="flex items-center justify-between bg-muted/50 px-3 py-1 border-b border-border">
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
        <div className="bg-muted/30 p-3 overflow-x-auto text-sm font-mono leading-relaxed">
          <code>{code}</code>
        </div>
      )}
      {state.status === "success" && view === "diagram" && (
        <div
          className="p-3 overflow-x-auto bg-background"
          // SVG is sanitized by mermaid's bundled DOMPurify with securityLevel "strict"
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      )}
      {state.status === "success" && view === "code" && (
        <CodeBlock code={code} language="mermaid" isStreaming={false} />
      )}
    </div>
  );
});

export default MermaidBlock;
