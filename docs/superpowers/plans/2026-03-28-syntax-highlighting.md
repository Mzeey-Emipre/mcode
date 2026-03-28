# Syntax Highlighting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Shiki-powered syntax highlighting to code blocks in agent chat bubbles, with a copy button, zero-layout-shift transitions, and theme-adaptive colors.

**Architecture:** A dedicated Web Worker runs Shiki with the JavaScript RegExp engine, lazy-loading languages on demand. The main thread renders plain code immediately, posts highlight requests to the Worker, and crossfades to highlighted output via a CSS grid stack. Streaming messages skip highlighting entirely; completed messages trigger the Worker.

**Tech Stack:** Shiki (core + JS engine), Web Worker, React hooks, Tailwind CSS, lucide-react

**Spec:** `docs/plans/2026-03-28-syntax-highlighting-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `apps/web/src/workers/shiki.worker.ts` | Shiki Web Worker: initializes highlighter, handles highlight requests |
| `apps/web/src/hooks/useHighlighter.ts` | React hook: manages Worker singleton, sends requests, returns HTML |
| `apps/web/src/hooks/useTheme.ts` | React hook: resolves current dark/light state from DOM |
| `apps/web/src/components/chat/CodeBlock.tsx` | Code block UI: header, copy button, grid stack plain/highlighted swap |
| `apps/web/src/__tests__/useHighlighter.test.ts` | Unit tests for the highlighter hook |
| `apps/web/src/__tests__/CodeBlock.test.tsx` | Unit tests for the CodeBlock component |

### Modified Files

| File | Change |
|------|--------|
| `apps/web/package.json` | Add `shiki` dependency |
| `apps/web/src/components/chat/MarkdownContent.tsx` | Accept `isStreaming` prop, delegate code blocks to `CodeBlock`, make `pre` a passthrough |
| `apps/web/src/components/chat/StreamingBubble.tsx` | Pass `isStreaming={true}` to `MarkdownContent` |
| `apps/web/src/components/chat/MessageBubble.tsx` | Pass `isStreaming={false}` to `MarkdownContent` |

---

## Task 1: Install Shiki

**Files:**
- Modify: `apps/web/package.json`

- [ ] **Step 1: Install shiki**

Run from `apps/web`:

```bash
bun add shiki
```

This installs the core library, the JS engine, and all language grammars (lazy-loaded at runtime, not bundled upfront).

- [ ] **Step 2: Verify installation**

```bash
cd apps/web && bun run typecheck
```

Expected: passes with no new errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/package.json apps/web/bun.lockb
git commit -m "chore: add shiki dependency for syntax highlighting"
```

---

## Task 2: Shiki Web Worker

**Files:**
- Create: `apps/web/src/workers/shiki.worker.ts`

- [ ] **Step 1: Create the workers directory and worker file**

Create `apps/web/src/workers/shiki.worker.ts`:

```ts
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegExpEngine } from "shiki/engine/javascript";

/** Message sent from main thread to request highlighting. */
interface HighlightRequest {
  id: string;
  code: string;
  language: string;
  theme: "github-dark" | "github-light";
}

/** Message sent back from worker with highlighted HTML. */
interface HighlightResponse {
  id: string;
  html: string;
  error?: string;
}

let highlighterPromise: ReturnType<typeof createHighlighterCore> | null = null;

/** Returns the singleton highlighter, creating it on first call. */
function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      engine: createJavaScriptRegExpEngine(),
      themes: [
        import("shiki/themes/github-dark.mjs"),
        import("shiki/themes/github-light.mjs"),
      ],
      langs: [],
    });
  }
  return highlighterPromise;
}

/** Dynamically imports a Shiki language grammar by name. */
async function loadLanguage(highlighter: Awaited<ReturnType<typeof createHighlighterCore>>, lang: string) {
  const loaded = highlighter.getLoadedLanguages();
  if (loaded.includes(lang)) return true;

  try {
    const mod = await import(`shiki/langs/${lang}.mjs`);
    await highlighter.loadLanguage(mod.default ?? mod);
    return true;
  } catch {
    return false;
  }
}

self.onmessage = async (e: MessageEvent<HighlightRequest>) => {
  const { id, code, language, theme } = e.data;

  try {
    const highlighter = await getHighlighter();
    const langLoaded = await loadLanguage(highlighter, language);
    const lang = langLoaded ? language : "text";

    // Load "text" as fallback if needed
    if (!langLoaded) {
      await loadLanguage(highlighter, "text");
    }

    const html = highlighter.codeToHtml(code, { lang, theme });

    self.postMessage({ id, html } satisfies HighlightResponse);
  } catch (err) {
    self.postMessage({
      id,
      html: "",
      error: err instanceof Error ? err.message : "Unknown error",
    } satisfies HighlightResponse);
  }
};
```

- [ ] **Step 2: Verify typecheck**

```bash
cd apps/web && bun run typecheck
```

Expected: passes. Vite handles `import.meta.url` Worker references and dynamic `import()` for language grammars natively.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/workers/shiki.worker.ts
git commit -m "feat: add Shiki Web Worker with JS engine and lazy language loading"
```

---

## Task 3: useTheme Hook

**Files:**
- Create: `apps/web/src/hooks/useTheme.ts`

- [ ] **Step 1: Create the useTheme hook**

Create `apps/web/src/hooks/useTheme.ts`:

```ts
import { useSyncExternalStore } from "react";

/** Resolved Shiki theme name based on the current app appearance. */
export type ShikiTheme = "github-dark" | "github-light";

/** Returns the current dark-mode class on `<html>`, reacting to changes. */
function subscribe(callback: () => void): () => void {
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.attributeName === "class") {
        callback();
        return;
      }
    }
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

function getSnapshot(): ShikiTheme {
  return document.documentElement.classList.contains("dark") ? "github-dark" : "github-light";
}

function getServerSnapshot(): ShikiTheme {
  return "github-dark";
}

/**
 * Returns the resolved Shiki theme name ("github-dark" | "github-light").
 * Reacts to dark-mode class changes on `<html>`.
 */
export function useShikiTheme(): ShikiTheme {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
```

- [ ] **Step 2: Verify typecheck**

```bash
cd apps/web && bun run typecheck
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/hooks/useTheme.ts
git commit -m "feat: add useShikiTheme hook for dark/light theme detection"
```

---

## Task 4: useHighlighter Hook

**Files:**
- Create: `apps/web/src/hooks/useHighlighter.ts`
- Create: `apps/web/src/__tests__/useHighlighter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/__tests__/useHighlighter.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useHighlighter } from "../hooks/useHighlighter";

// Mock the Worker since jsdom doesn't support real Workers
class MockWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  dispatchEvent = vi.fn(() => false);
  onerror = null;
  onmessageerror = null;
}

let mockWorkerInstance: MockWorker;

beforeEach(() => {
  mockWorkerInstance = new MockWorker();
  vi.stubGlobal("Worker", class {
    onmessage: ((e: MessageEvent) => void) | null = null;
    postMessage: typeof MockWorker.prototype.postMessage;
    terminate: typeof MockWorker.prototype.terminate;
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    dispatchEvent = vi.fn(() => false);
    onerror = null;
    onmessageerror = null;

    constructor() {
      mockWorkerInstance = this as unknown as MockWorker;
      this.postMessage = vi.fn();
      this.terminate = vi.fn();
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useHighlighter", () => {
  it("returns null html initially", () => {
    const { result } = renderHook(() =>
      useHighlighter("const x = 1;", "typescript", "github-dark"),
    );
    expect(result.current.html).toBeNull();
  });

  it("posts a message to the worker with code, language, and theme", () => {
    renderHook(() =>
      useHighlighter("const x = 1;", "typescript", "github-dark"),
    );
    expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "const x = 1;",
        language: "typescript",
        theme: "github-dark",
      }),
    );
  });

  it("returns highlighted html when worker responds", async () => {
    const { result } = renderHook(() =>
      useHighlighter("const x = 1;", "typescript", "github-dark"),
    );

    const sentId = mockWorkerInstance.postMessage.mock.calls[0][0].id;

    act(() => {
      mockWorkerInstance.onmessage?.(
        new MessageEvent("message", {
          data: { id: sentId, html: '<pre class="shiki">highlighted</pre>' },
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.html).toBe('<pre class="shiki">highlighted</pre>');
    });
  });

  it("re-requests when code changes", () => {
    const { rerender } = renderHook(
      ({ code }) => useHighlighter(code, "typescript", "github-dark"),
      { initialProps: { code: "const x = 1;" } },
    );

    rerender({ code: "const y = 2;" });

    expect(mockWorkerInstance.postMessage).toHaveBeenCalledTimes(2);
    expect(mockWorkerInstance.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: "const y = 2;" }),
    );
  });

  it("re-requests when theme changes", () => {
    const { rerender } = renderHook(
      ({ theme }) => useHighlighter("const x = 1;", "typescript", theme),
      { initialProps: { theme: "github-dark" as const } },
    );

    rerender({ theme: "github-light" });

    expect(mockWorkerInstance.postMessage).toHaveBeenCalledTimes(2);
    expect(mockWorkerInstance.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: "github-light" }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web && bun run test -- src/__tests__/useHighlighter.test.ts
```

Expected: FAIL with "Cannot find module '../hooks/useHighlighter'"

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/hooks/useHighlighter.ts`:

```ts
import { useEffect, useRef, useState } from "react";
import type { ShikiTheme } from "./useTheme";

/** Response from the Shiki Web Worker. */
interface HighlightResponse {
  id: string;
  html: string;
  error?: string;
}

let sharedWorker: Worker | null = null;
let workerGeneration = 0;
const pending = new Map<string, (html: string | null) => void>();

/** Creates and configures a new Worker instance. */
function createWorkerInstance(): Worker {
  const worker = new Worker(
    new URL("../workers/shiki.worker.ts", import.meta.url),
    { type: "module" },
  );
  worker.onmessage = (e: MessageEvent<HighlightResponse>) => {
    const { id, html, error } = e.data;
    if (error) {
      console.warn("[shiki-worker]", error);
    }
    const resolve = pending.get(id);
    if (resolve) {
      pending.delete(id);
      resolve(error ? null : html);
    }
  };
  worker.onerror = () => {
    sharedWorker = null;
    workerGeneration++;
    // Resolve all pending requests with null so hooks fall back to plain rendering
    for (const resolve of pending.values()) {
      resolve(null);
    }
    pending.clear();
  };
  return worker;
}

/** Returns the shared singleton Worker, creating it on first call or after a crash. */
function getWorker(): Worker {
  if (!sharedWorker) {
    sharedWorker = createWorkerInstance();
  }
  return sharedWorker;
}

let nextId = 0;

/**
 * Sends code to the Shiki Web Worker for highlighting.
 * Returns `{ html }` where `html` is `null` until the Worker responds.
 */
export function useHighlighter(
  code: string,
  language: string,
  theme: ShikiTheme,
): { html: string | null } {
  const [html, setHtml] = useState<string | null>(null);
  const currentRequestId = useRef<string | null>(null);

  useEffect(() => {
    const worker = getWorker();

    const id = `hl-${nextId++}`;
    currentRequestId.current = id;

    pending.set(id, (result) => {
      if (currentRequestId.current === id) {
        setHtml(result);
      }
    });

    worker.postMessage({ id, code, language, theme });

    return () => {
      pending.delete(id);
      currentRequestId.current = null;
      releaseWorker();
    };
  }, [code, language, theme]);

  return { html };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/web && bun run test -- src/__tests__/useHighlighter.test.ts
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hooks/useHighlighter.ts apps/web/src/__tests__/useHighlighter.test.ts
git commit -m "feat: add useHighlighter hook with Web Worker singleton management"
```

---

## Task 5: CodeBlock Component

**Files:**
- Create: `apps/web/src/components/chat/CodeBlock.tsx`
- Create: `apps/web/src/__tests__/CodeBlock.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/__tests__/CodeBlock.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CodeBlock } from "../components/chat/CodeBlock";

// Mock useHighlighter to control Worker responses
vi.mock("../hooks/useHighlighter", () => ({
  useHighlighter: vi.fn(() => ({ html: null })),
}));

// Mock useTheme
vi.mock("../hooks/useTheme", () => ({
  useShikiTheme: vi.fn(() => "github-dark"),
}));

import { useHighlighter } from "../hooks/useHighlighter";

const mockUseHighlighter = vi.mocked(useHighlighter);

describe("CodeBlock", () => {
  it("renders plain code as fallback when html is null", () => {
    mockUseHighlighter.mockReturnValue({ html: null });

    render(<CodeBlock code="const x = 1;" language="typescript" isStreaming={false} />);

    expect(screen.getByText("const x = 1;")).toBeInTheDocument();
  });

  it("shows the language label", () => {
    mockUseHighlighter.mockReturnValue({ html: null });

    render(<CodeBlock code="print('hi')" language="python" isStreaming={false} />);

    expect(screen.getByText("python")).toBeInTheDocument();
  });

  it("renders highlighted html when available", () => {
    mockUseHighlighter.mockReturnValue({
      html: '<pre class="shiki github-dark"><code><span>const x = 1;</span></code></pre>',
    });

    const { container } = render(
      <CodeBlock code="const x = 1;" language="typescript" isStreaming={false} />,
    );

    const highlighted = container.querySelector(".shiki");
    expect(highlighted).toBeInTheDocument();
  });

  it("does not call useHighlighter when streaming", () => {
    mockUseHighlighter.mockReturnValue({ html: null });

    render(<CodeBlock code="const x = 1;" language="typescript" isStreaming={true} />);

    expect(mockUseHighlighter).not.toHaveBeenCalled();
  });

  it("shows a copy button when not streaming", () => {
    mockUseHighlighter.mockReturnValue({ html: null });

    render(<CodeBlock code="const x = 1;" language="typescript" isStreaming={false} />);

    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
  });

  it("does not show a copy button when streaming", () => {
    render(<CodeBlock code="const x = 1;" language="typescript" isStreaming={true} />);

    expect(screen.queryByRole("button", { name: /copy/i })).not.toBeInTheDocument();
  });

  it("copies code to clipboard on button click", async () => {
    mockUseHighlighter.mockReturnValue({ html: null });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<CodeBlock code="const x = 1;" language="typescript" isStreaming={false} />);

    fireEvent.click(screen.getByRole("button", { name: /copy/i }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("const x = 1;");
    });
  });

  it("adds ready class when highlighted html is available", () => {
    mockUseHighlighter.mockReturnValue({
      html: '<pre class="shiki"><code>highlighted</code></pre>',
    });

    const { container } = render(
      <CodeBlock code="const x = 1;" language="typescript" isStreaming={false} />,
    );

    const wrapper = container.querySelector("[data-code-block]");
    expect(wrapper?.className).toContain("ready");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web && bun run test -- src/__tests__/CodeBlock.test.tsx
```

Expected: FAIL with "Cannot find module '../components/chat/CodeBlock'"

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/components/chat/CodeBlock.tsx`:

```tsx
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
  // Hook is always called unconditionally (rules of hooks); `enabled` suppresses the Worker request.
  const { html } = useHighlighter(code, language || "text", theme, !isStreaming);

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
      // Clipboard write can fail in insecure contexts
    }
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/web && bun run test -- src/__tests__/CodeBlock.test.tsx
```

Expected: all 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/chat/CodeBlock.tsx apps/web/src/__tests__/CodeBlock.test.tsx
git commit -m "feat: add CodeBlock component with copy button and grid stack transition"
```

---

## Task 6: Wire CodeBlock into MarkdownContent

**Files:**
- Modify: `apps/web/src/components/chat/MarkdownContent.tsx`

- [ ] **Step 1: Update MarkdownContent to accept isStreaming and use CodeBlock**

Replace the full contents of `apps/web/src/components/chat/MarkdownContent.tsx` with:

```tsx
import { memo, useMemo } from "react";
import type { Element } from "hast";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";

/** Props for {@link MarkdownContent}. */
interface MarkdownContentProps {
  /** Raw markdown string to render. */
  content: string;
  /** When true, code blocks skip syntax highlighting. Defaults to false. */
  isStreaming?: boolean;
}

/** Stable remark plugin list, hoisted to avoid re-creating on every render. */
const plugins = [remarkGfm];

/**
 * Builds the react-markdown component overrides.
 * Must be recreated when `isStreaming` changes so code blocks get the right prop.
 */
function makeComponents(isStreaming: boolean) {
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
    pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    code: ({ children, className, node }: { children?: React.ReactNode; className?: string; node?: Element }) => {
      // Detect inline code: if parent is not <pre>, it's inline
      const isInline = node?.position ? !className : true;

      if (isInline) {
        return (
          <code className="bg-muted rounded px-1.5 py-0.5 text-sm font-mono">
            {children}
          </code>
        );
      }

      const langMatch = className?.match(/language-(\S+)/);
      const language = langMatch ? langMatch[1] : "";
      const code = String(children).replace(/\n$/, "");

      return <CodeBlock code={code} language={language} isStreaming={isStreaming} />;
    },
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
}

/** Renders a markdown string with GFM support. Memoized to skip re-renders when content is unchanged. */
export const MarkdownContent = memo(function MarkdownContent({
  content,
  isStreaming = false,
}: MarkdownContentProps) {
  const components = useMemo(() => makeComponents(isStreaming), [isStreaming]);

  return (
    <ReactMarkdown remarkPlugins={plugins} components={components}>
      {content}
    </ReactMarkdown>
  );
});
```

Key changes from the original:
- Added `isStreaming` prop (defaults to `false` for backward compatibility)
- `pre` renderer is now a passthrough (`<>{children}</>`) since `CodeBlock` handles the wrapper
- `code` renderer detects inline vs block: inline keeps the original `<code>` styling, block delegates to `CodeBlock`
- `components` object is created via `makeComponents(isStreaming)` + `useMemo` so it updates when `isStreaming` changes

- [ ] **Step 2: Verify typecheck**

```bash
cd apps/web && bun run typecheck
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/chat/MarkdownContent.tsx
git commit -m "feat: wire CodeBlock into MarkdownContent with isStreaming prop"
```

---

## Task 7: Thread isStreaming Through Bubbles

**Files:**
- Modify: `apps/web/src/components/chat/StreamingBubble.tsx`
- Modify: `apps/web/src/components/chat/MessageBubble.tsx`

- [ ] **Step 1: Update StreamingBubble**

In `apps/web/src/components/chat/StreamingBubble.tsx`, change line 18:

```tsx
// Before:
<MarkdownContent content={content} />

// After:
<MarkdownContent content={content} isStreaming />
```

- [ ] **Step 2: Update MessageBubble**

In `apps/web/src/components/chat/MessageBubble.tsx`, change line 112:

```tsx
// Before:
<MarkdownContent content={message.content} />

// After:
<MarkdownContent content={message.content} isStreaming={false} />
```

The `isStreaming={false}` is technically the default, but being explicit makes the intent clear when reading the code.

- [ ] **Step 3: Verify typecheck**

```bash
cd apps/web && bun run typecheck
```

Expected: passes.

- [ ] **Step 4: Run all tests**

```bash
cd apps/web && bun run test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/chat/StreamingBubble.tsx apps/web/src/components/chat/MessageBubble.tsx
git commit -m "feat: thread isStreaming prop through bubble components"
```

---

## Task 8: Manual Smoke Test

- [ ] **Step 1: Start the dev server**

```bash
cd apps/web && bun run dev
```

- [ ] **Step 2: Open the app and send a test prompt**

Send a message asking the agent to generate code in multiple languages (TypeScript, Python, Bash). Verify:

1. During streaming: code blocks show plain monospace text, no copy button
2. After completion: code blocks get syntax colors, copy button appears
3. Click copy button: code is copied, checkmark icon shows for 2s
4. Toggle dark/light theme: code blocks re-highlight with the correct theme
5. No layout shift when highlighting kicks in

- [ ] **Step 3: Check for console errors**

Open DevTools, verify no errors related to Worker initialization or Shiki language loading.

- [ ] **Step 4: Commit any fixes**

If any issues found, fix and commit with descriptive messages.

---

## Task 9: Final Verification

- [ ] **Step 1: Run typecheck**

```bash
cd apps/web && bun run typecheck
```

Expected: passes.

- [ ] **Step 2: Run all tests**

```bash
cd apps/web && bun run test
```

Expected: all tests pass.

- [ ] **Step 3: Run lint**

```bash
cd apps/web && bun run lint
```

Expected: no new lint errors.

- [ ] **Step 4: Build**

```bash
cd apps/web && bun run build
```

Expected: builds successfully. Worker is bundled as a separate chunk.
