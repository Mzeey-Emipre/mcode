import {
  memo,
  Profiler,
  useState,
  useCallback,
  useRef,
  useEffect,
  type ProfilerOnRenderCallback,
  type ReactNode,
  type RefObject,
} from "react";
import { Copy, Check } from "lucide-react";
import { useHighlighter } from "@/hooks/useHighlighter";
import { useShikiTheme } from "@/hooks/useTheme";
import { recordShikiRendererCompletion } from "@/performance/shiki-performance";

const performanceBuild =
  import.meta.env.VITE_MCODE_PERFORMANCE_MODE === "profiling" ||
  import.meta.env.VITE_MCODE_PERFORMANCE_MODE === "production";

/** Props for {@link CodeBlock}. */
interface CodeBlockProps {
  /** Raw code string to display. */
  code: string;
  /** Language identifier from the code fence (e.g. "typescript", "python"). */
  language: string;
  /**
   * Optional header text; when set (e.g. basename inferred from a path), shown instead of {@link language}.
   */
  languageLabel?: string;
  /** When true, shows raw code inline and hides the copy button. */
  isStreaming: boolean;
  /** When true, skips Shiki highlighting but keeps the copy button and language label. */
  disableHighlighting?: boolean;
  /** Thread that owns this Markdown block. */
  threadId?: string | null;
  /** Uses the chat coordinator for settled assistant Markdown. */
  chatHighlighting?: boolean;
}

interface MeasuredCodeBlockProps {
  children: ReactNode;
  measurementId?: string | null;
}

/** Adds performance-only React lifecycle observation without changing the DOM tree. */
function MeasuredCodeBlock({
  children,
  measurementId,
}: MeasuredCodeBlockProps) {
  const recordCommit: ProfilerOnRenderCallback = useCallback((_id, _phase, actualDuration, _baseDuration, startTime, commitTime) => {
    if (!measurementId) return;
    recordShikiRendererCompletion(measurementId, actualDuration, startTime, commitTime);
  }, [measurementId]);

  return <Profiler id="shiki-code-block" onRender={recordCommit}>{children}</Profiler>;
}

function useHighlightVisibility(chatHighlighting: boolean, containerRef: RefObject<HTMLDivElement | null>): boolean {
  const [isVisible, setIsVisible] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (!chatHighlighting) return;
    const element = containerRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setIsVisible(true);
      return;
    }
    setIsVisible(false);
    const observer = new IntersectionObserver(([entry]) => setIsVisible(entry?.isIntersecting === true));
    observer.observe(element);
    return () => observer.disconnect();
  }, [chatHighlighting, containerRef]);
  return isVisible;
}

function CodeBlockHeader({ language, languageLabel, isStreaming, copied, onCopy }: { language: string; languageLabel: string | undefined; isStreaming: boolean; copied: boolean; onCopy: () => Promise<void> }) {
  return <div className="flex items-center justify-between bg-background px-3 py-1 border-b border-border">
    <span className="text-xs text-muted-foreground">{languageLabel || language || "text"}</span>
    {!isStreaming && <button type="button" onClick={onCopy} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors" aria-label={copied ? "Copied" : "Copy code"}>{copied ? <Check size={13} /> : <Copy size={13} />}</button>}
  </div>;
}

function CodeBlockPresentation({ containerRef, code, language, languageLabel, isStreaming, html, copied, onCopy }: { containerRef: RefObject<HTMLDivElement | null>; code: string; language: string; languageLabel: string | undefined; isStreaming: boolean; html: string | null; copied: boolean; onCopy: () => Promise<void> }) {
  const isReady = html !== null && html !== "";
  const codeScrollBody = "overflow-x-auto bg-muted text-foreground text-sm font-mono leading-relaxed";
  const codePreInner = "m-0 min-w-full w-max bg-transparent p-3";
  return <div ref={containerRef} className="my-2 min-w-0 rounded-lg overflow-hidden border border-border">
    <CodeBlockHeader language={language} languageLabel={languageLabel} isStreaming={isStreaming} copied={copied} onCopy={onCopy} />
    {isStreaming ? <div className={codeScrollBody}><pre className={`${codePreInner} text-foreground`}><code>{code}</code></pre></div> : <div data-code-block className={`grid min-w-0 ${isReady ? "ready" : ""}`}>
      <div className={`${codeScrollBody} [grid-row:1/2] [grid-column:1/2] ${isReady ? "invisible opacity-0" : "visible opacity-100"}`}><pre className={codePreInner}><code>{code}</code></pre></div>
      {html && <div className={`${codeScrollBody} [grid-row:1/2] [grid-column:1/2] transition-opacity duration-150 ease-in
        [&_pre]:m-0 [&_pre]:min-w-full [&_pre]:w-max [&_pre]:bg-transparent [&_pre]:!bg-transparent [&_pre]:p-3
        [&_pre]:text-sm [&_pre]:leading-relaxed [&_pre]:text-foreground
        [&_code]:text-sm [&_code]:font-mono`} dangerouslySetInnerHTML={{ __html: html }} />}
    </div>}
  </div>;
}

/**
 * Renders a syntax-highlighted code block with a language header and copy button.
 * Uses a CSS grid stack to crossfade from plain to highlighted code with zero layout shift.
 */
export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  languageLabel,
  isStreaming,
  disableHighlighting = false,
  threadId,
  chatHighlighting = false,
}: CodeBlockProps) {
  const theme = useShikiTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const isVisible = useHighlightVisibility(chatHighlighting, containerRef);

  // The hook is always called unconditionally (rules of hooks), but `enabled`
  // suppresses the Worker postMessage during streaming so no requests are wasted.
  const highlightOptions = chatHighlighting
    ? {
        visible: isVisible,
        threadId: threadId ?? null,
        coordinator: true,
      }
    : undefined;
  const { html, measurementId } = useHighlighter(
    code,
    language || "text",
    theme,
    !isStreaming && !disableHighlighting,
    highlightOptions,
  );

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
      // Clipboard write can fail (e.g. permissions denied, insecure context).
      // Silently ignore so the UI doesn't show a false "copied" checkmark.
    }
  }, [code]);

  const content = <CodeBlockPresentation containerRef={containerRef} code={code} language={language} languageLabel={languageLabel} isStreaming={isStreaming} html={html} copied={copied} onCopy={handleCopy} />;
  return performanceBuild
    ? <MeasuredCodeBlock measurementId={measurementId}>{content}</MeasuredCodeBlock>
    : content;
});
