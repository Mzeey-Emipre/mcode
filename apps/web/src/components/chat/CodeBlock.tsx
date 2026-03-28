import { memo, useState, useCallback } from "react";
import { Copy, Check } from "lucide-react";
import { useHighlighter } from "@/hooks/useHighlighter";
import { useShikiTheme } from "@/hooks/useTheme";

/** Props for {@link CodeBlock}. */
interface CodeBlockProps {
  /** Raw code string to display. */
  code: string;
  /** Language identifier from the code fence (e.g. "typescript", "python"). */
  language: string;
  /** When true, skips highlighting and hides the copy button. */
  isStreaming: boolean;
}

/**
 * Renders a syntax-highlighted code block with a language header and copy button.
 * Uses a CSS grid stack to crossfade from plain to highlighted code with zero layout shift.
 */
export const CodeBlock = memo(function CodeBlock({ code, language, isStreaming }: CodeBlockProps) {
  const theme = useShikiTheme();
  // Always call the hook unconditionally (rules of hooks), but ignore the
  // result when streaming so the Worker output is never rendered mid-stream.
  const { html: highlightedHtml } = useHighlighter(code, language || "text", theme);
  const html = isStreaming ? null : highlightedHtml;

  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  const isReady = html !== null;

  return (
    <div className="my-2 rounded-lg overflow-hidden border border-border">
      <div className="flex items-center justify-between bg-muted/50 px-3 py-1 border-b border-border">
        <span className="text-xs text-muted-foreground">{language || "text"}</span>
        {!isStreaming && (
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            aria-label={copied ? "Copied" : "Copy code"}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        )}
      </div>
      {isStreaming ? (
        <pre className="bg-muted/30 p-3 overflow-x-auto text-sm font-mono leading-relaxed">
          <code>{code}</code>
        </pre>
      ) : (
        <div
          data-code-block
          className={`grid ${isReady ? "ready" : ""}`}
        >
          {/* Plain text layer */}
          <pre
            className={`bg-muted/30 p-3 overflow-x-auto text-sm font-mono leading-relaxed
              [grid-row:1/2] [grid-column:1/2]
              ${isReady ? "invisible opacity-0" : "visible opacity-100"}`}
          >
            <code>{code}</code>
          </pre>
          {/* Highlighted layer */}
          {html && (
            <div
              className="[grid-row:1/2] [grid-column:1/2] overflow-x-auto transition-opacity duration-150 ease-in
                [&_pre]:p-3 [&_pre]:text-sm [&_pre]:leading-relaxed [&_pre]:!bg-muted/30 [&_pre]:m-0
                [&_code]:text-sm [&_code]:font-mono"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
        </div>
      )}
    </div>
  );
});
