# Markdown Rendering & Mermaid Diagrams Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render user messages with GFM markdown and add mermaid diagram visualization to all messages.

**Architecture:** Reuse the existing `MarkdownContent` component for user messages with a new `variant` prop that controls prose styling and disables Shiki highlighting. Add a new `MermaidBlock` component that lazy-loads mermaid and renders SVG diagrams with a diagram/code toggle.

**Tech Stack:** React 19, react-markdown 10, remark-gfm, mermaid >= 10.0.0, Lucide icons, Vitest + Testing Library

**Spec:** [`docs/specs/2026-04-13-md-rendering-mermaid-design.md`](2026-04-13-md-rendering-mermaid-design.md)

---

## Chunk 1: CodeBlock `disableHighlighting` Prop

### Task 1: Add `disableHighlighting` prop to CodeBlock

**Files:**
- Modify: `apps/web/src/components/chat/CodeBlock.tsx:7-14,20-24`
- Test: `apps/web/src/__tests__/CodeBlock.test.tsx`

- [ ] **Step 1: Write failing tests for `disableHighlighting`**

Add these tests to `apps/web/src/__tests__/CodeBlock.test.tsx`:

```tsx
it("skips highlighting when disableHighlighting is true", () => {
  mockUseHighlighter.mockReturnValue({ html: null });
  render(
    <CodeBlock code="const x = 1;" language="typescript" isStreaming={false} disableHighlighting />,
  );
  expect(mockUseHighlighter).toHaveBeenCalledWith(
    "const x = 1;",
    "typescript",
    "github-dark",
    false, // enabled = false when disableHighlighting is true
  );
});

it("still shows copy button when disableHighlighting is true", () => {
  mockUseHighlighter.mockReturnValue({ html: null });
  render(
    <CodeBlock code="const x = 1;" language="typescript" isStreaming={false} disableHighlighting />,
  );
  expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
});

it("still shows language label when disableHighlighting is true", () => {
  mockUseHighlighter.mockReturnValue({ html: null });
  render(
    <CodeBlock code="print('hi')" language="python" isStreaming={false} disableHighlighting />,
  );
  expect(screen.getByText("python")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run src/__tests__/CodeBlock.test.tsx`
Expected: FAIL - `disableHighlighting` prop not recognized

- [ ] **Step 3: Implement `disableHighlighting` prop**

In `apps/web/src/components/chat/CodeBlock.tsx`:

Update the props interface (line 7-14):

```tsx
/** Props for {@link CodeBlock}. */
interface CodeBlockProps {
  /** Raw code string to display. */
  code: string;
  /** Language identifier from the code fence (e.g. "typescript", "python"). */
  language: string;
  /** When true, shows raw code inline and hides the copy button. */
  isStreaming: boolean;
  /** When true, skips Shiki highlighting but keeps the copy button and language label. */
  disableHighlighting?: boolean;
}
```

Update the component signature and `useHighlighter` call (line 20-24):

```tsx
export const CodeBlock = memo(function CodeBlock({ code, language, isStreaming, disableHighlighting = false }: CodeBlockProps) {
  const theme = useShikiTheme();
  const { html } = useHighlighter(code, language || "text", theme, !isStreaming && !disableHighlighting);
```

No other changes needed. When `disableHighlighting` is true, `enabled` is `false`, so `html` stays `null` and the plain `<pre><code>` fallback renders. The copy button is gated on `!isStreaming` (not on highlighting), so it remains visible.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run src/__tests__/CodeBlock.test.tsx`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/chat/CodeBlock.tsx apps/web/src/__tests__/CodeBlock.test.tsx
git commit -m "feat: add disableHighlighting prop to CodeBlock (#256)"
```

---

## Chunk 2: MarkdownContent `variant` Prop

### Task 2: Add `variant` prop to MarkdownContent with user-bubble overrides

**Files:**
- Modify: `apps/web/src/components/chat/MarkdownContent.tsx:7-12,18-70,76-108,111-115`
- Test: `apps/web/src/__tests__/MarkdownContent.test.tsx` (new)

- [ ] **Step 1: Write failing tests for variant-aware rendering**

The file `apps/web/src/__tests__/MarkdownContent.test.tsx` already exists with link-handling tests and a simple `CodeBlock` mock. Upgrade the mock to `vi.fn()` and add the new variant tests while preserving all existing tests.

Replace the existing `CodeBlock` mock (lines 6-8) with:

```tsx
vi.mock("../components/chat/CodeBlock", () => ({
  CodeBlock: vi.fn(({ code, language, disableHighlighting }: {
    code: string;
    language: string;
    disableHighlighting?: boolean;
  }) => (
    <pre data-testid="code-block" data-language={language} data-disable-highlighting={disableHighlighting}>
      {code}
    </pre>
  )),
}));
```

Add these imports after line 3:

```tsx
import { CodeBlock } from "../components/chat/CodeBlock";

const mockCodeBlock = vi.mocked(CodeBlock);
```

Then add the following test suites **after** the existing `"MarkdownContent link handling"` describe block:

```tsx
describe("MarkdownContent variant styling", () => {
  describe("variant='assistant' (default)", () => {
    it("renders inline code with bg-muted", () => {
      const { container } = render(
        <MarkdownContent content="Use `foo` here" />,
      );
      const code = container.querySelector("code");
      expect(code?.className).toContain("bg-muted");
    });

    it("renders links with text-primary", () => {
      const { container } = render(
        <MarkdownContent content="[link](https://example.com)" />,
      );
      const link = container.querySelector("a");
      expect(link?.className).toContain("text-primary");
    });

    it("passes disableHighlighting=false to CodeBlock", () => {
      render(<MarkdownContent content={'```ts\nconst x = 1;\n```'} />);
      expect(mockCodeBlock).toHaveBeenCalledWith(
        expect.objectContaining({ disableHighlighting: false }),
        expect.anything(),
      );
    });
  });

  describe("variant='user'", () => {
    it("renders inline code with bg-primary-foreground/15", () => {
      const { container } = render(
        <MarkdownContent content="Use `foo` here" variant="user" />,
      );
      const code = container.querySelector("code");
      expect(code?.className).toContain("bg-primary-foreground/15");
    });

    it("renders links with text-primary-foreground", () => {
      const { container } = render(
        <MarkdownContent content="[link](https://example.com)" variant="user" />,
      );
      const link = container.querySelector("a");
      expect(link?.className).toContain("text-primary-foreground");
    });

    it("renders blockquote with border-primary-foreground/40", () => {
      const { container } = render(
        <MarkdownContent content="> quote" variant="user" />,
      );
      const blockquote = container.querySelector("blockquote");
      expect(blockquote?.className).toContain("border-primary-foreground/40");
    });

    it("passes disableHighlighting=true to CodeBlock", () => {
      render(<MarkdownContent content={'```ts\nconst x = 1;\n```'} variant="user" />);
      expect(mockCodeBlock).toHaveBeenCalledWith(
        expect.objectContaining({ disableHighlighting: true }),
        expect.anything(),
      );
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run src/__tests__/MarkdownContent.test.tsx`
Expected: FAIL - `variant` prop not recognized

- [ ] **Step 3: Implement variant-aware MarkdownContent**

In `apps/web/src/components/chat/MarkdownContent.tsx`:

Update the props interface (replace lines 7-12):

```tsx
/** Props for {@link MarkdownContent}. */
interface MarkdownContentProps {
  /** Raw markdown string to render. */
  content: string;
  /** When true, code blocks skip syntax highlighting. Defaults to false. */
  isStreaming?: boolean;
  /** Controls prose styling. "user" adapts colors for the primary-colored user bubble. Defaults to "assistant". */
  variant?: "assistant" | "user";
}
```

Convert `staticComponents` from a plain object to a function that returns variant-aware overrides. Replace lines 18-70:

```tsx
/** Builds static component overrides based on the variant. */
function makeStaticComponents(variant: "assistant" | "user") {
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
      const safeHref = href && /^https?:|^mailto:/.test(href) ? href : undefined;
      return (
        <a
          href={safeHref}
          className={isUser
            ? "text-primary-foreground underline hover:opacity-80"
            : "text-primary underline hover:text-primary"}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => {
            if (!safeHref) return;
            e.preventDefault();
            if (window.desktopBridge?.openExternalUrl) {
              window.desktopBridge.openExternalUrl(safeHref);
            } else {
              window.open(safeHref, "_blank", "noopener,noreferrer");
            }
          }}
        >
          {children}
        </a>
      );
    },
    blockquote: ({ children }: { children?: React.ReactNode }) => (
      <blockquote className={`border-l-2 pl-3 my-2 italic ${
        isUser
          ? "border-primary-foreground/40 text-primary-foreground/80"
          : "border-border text-muted-foreground"
      }`}>
        {children}
      </blockquote>
    ),
    pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    hr: () => <hr className={`my-4 ${isUser ? "border-primary-foreground/20" : "border-border"}`} />,
    table: ({ children }: { children?: React.ReactNode }) => (
      <div className="overflow-x-auto my-2">
        <table className={`min-w-full border rounded ${
          isUser ? "border-primary-foreground/20" : "border-border"
        }`}>{children}</table>
      </div>
    ),
    th: ({ children }: { children?: React.ReactNode }) => (
      <th className={`border px-3 py-1.5 text-left text-sm font-semibold ${
        isUser ? "border-primary-foreground/20 bg-primary-foreground/10" : "border-border bg-muted/50"
      }`}>
        {children}
      </th>
    ),
    td: ({ children }: { children?: React.ReactNode }) => (
      <td className={`border px-3 py-1.5 text-sm ${
        isUser ? "border-primary-foreground/20" : "border-border"
      }`}>{children}</td>
    ),
  };
}
```

Update `makeComponents` signature (replace lines 76-108):

```tsx
/**
 * Builds the full component override map.
 * Static overrides depend on `variant`; the `code` override also depends on `isStreaming`.
 */
function makeComponents(isStreaming: boolean, variant: "assistant" | "user") {
  const isUser = variant === "user";

  return {
    ...makeStaticComponents(variant),
    code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
      const rawContent = String(children);
      const isInline = !className && !rawContent.includes("\n");

      if (isInline) {
        return (
          <code className={`rounded px-1.5 py-0.5 text-sm font-mono ${
            isUser ? "bg-primary-foreground/15" : "bg-muted"
          }`}>
            {children}
          </code>
        );
      }

      const langMatch = className?.match(/language-(\S+)/);
      const language = langMatch ? langMatch[1] : "";

      if (language === "plan-questions") return null;

      const code = String(children).replace(/\n$/, "");

      return <CodeBlock code={code} language={language} isStreaming={isStreaming} disableHighlighting={isUser} />;
    },
  };
}
```

Update the component to accept and use `variant` (replace lines 111-122):

```tsx
/** Renders a markdown string with GFM support. Memoized to skip re-renders when content is unchanged. */
export const MarkdownContent = memo(function MarkdownContent({
  content,
  isStreaming = false,
  variant = "assistant",
}: MarkdownContentProps) {
  const components = useMemo(() => makeComponents(isStreaming, variant), [isStreaming, variant]);

  return (
    <ReactMarkdown remarkPlugins={plugins} components={components}>
      {content}
    </ReactMarkdown>
  );
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run src/__tests__/MarkdownContent.test.tsx`
Expected: All tests PASS

- [ ] **Step 5: Run existing CodeBlock tests to verify no regressions**

Run: `cd apps/web && npx vitest run src/__tests__/CodeBlock.test.tsx`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/chat/MarkdownContent.tsx apps/web/src/__tests__/MarkdownContent.test.tsx
git commit -m "feat: add variant prop to MarkdownContent for user bubble styling (#256)"
```

---

## Chunk 3: User Message Markdown in MessageBubble

### Task 3: Replace plain text with MarkdownContent in user messages

**Files:**
- Modify: `apps/web/src/components/chat/MessageBubble.tsx:216-218`
- Test: `apps/web/src/__tests__/MessageBubble.test.tsx` (new)

- [ ] **Step 1: Write failing test for user message markdown rendering**

Create `apps/web/src/__tests__/MessageBubble.test.tsx`. This tests that `MessageBubble` renders user messages through `MarkdownContent` (not plain `<p>`), so it fails until the implementation change.

```tsx
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { MessageBubble } from "../components/chat/MessageBubble";

// Mock MarkdownContent to detect when it's used
vi.mock("../components/chat/MarkdownContent", () => ({
  __esModule: true,
  default: ({ content, variant }: { content: string; variant?: string }) => (
    <div data-testid="markdown-content" data-variant={variant}>{content}</div>
  ),
  MarkdownContent: ({ content, variant }: { content: string; variant?: string }) => (
    <div data-testid="markdown-content" data-variant={variant}>{content}</div>
  ),
}));

const makeMessage = (content: string) => ({
  id: "msg-1",
  thread_id: "thread-1",
  role: "user" as const,
  content,
  timestamp: new Date().toISOString(),
  attachments: [],
});

describe("MessageBubble user messages", () => {
  it("renders user message through MarkdownContent with variant='user'", () => {
    const { container } = render(
      <MessageBubble message={makeMessage("Hello **world**")} />,
    );
    const md = container.querySelector("[data-testid='markdown-content']");
    expect(md).toBeInTheDocument();
    expect(md?.getAttribute("data-variant")).toBe("user");
  });

  it("does not render user message as plain <p>", () => {
    const { container } = render(
      <MessageBubble message={makeMessage("Hello **world**")} />,
    );
    // After the change, user text should NOT be in a plain <p> with whitespace-pre-wrap
    const plainP = container.querySelector("p.whitespace-pre-wrap");
    expect(plainP).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run src/__tests__/MessageBubble.test.tsx`
Expected: FAIL - user message still renders as `<p>`, `markdown-content` testid not found

- [ ] **Step 3: Update MessageBubble to use MarkdownContent for user messages**

In `apps/web/src/components/chat/MessageBubble.tsx`, replace lines 216-218:

```tsx
// Before
{textContent.trim() && (
  <p className="whitespace-pre-wrap break-words">{textContent}</p>
)}

// After
{textContent.trim() && (
  <Suspense>
    <LazyMarkdownContent content={textContent} isStreaming={false} variant="user" />
  </Suspense>
)}
```

No new imports needed - `Suspense` and `LazyMarkdownContent` are already imported at lines 1 and 5.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run src/__tests__/MessageBubble.test.tsx`
Expected: All tests PASS

- [ ] **Step 5: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/chat/MessageBubble.tsx apps/web/src/__tests__/MessageBubble.test.tsx
git commit -m "feat: render user messages with GFM markdown (#256)"
```

---

## Chunk 4: MermaidBlock Component

### Task 4: Install mermaid dependency and update Vite config

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/vite.config.ts:22-53`

- [ ] **Step 1: Install mermaid**

Run: `cd apps/web && bun add mermaid@^11`

(Mermaid v11 is latest stable, satisfies the >= 10.0.0 constraint for bundled DOMPurify.)

- [ ] **Step 2: Add mermaid to `optimizeDeps.exclude` in Vite config**

In `apps/web/vite.config.ts`, add `exclude` to the `optimizeDeps` block (after line 53):

```ts
  optimizeDeps: {
    include: [
      // ... existing entries unchanged ...
    ],
    exclude: ["mermaid"],
  },
```

- [ ] **Step 3: Commit**

Note: Run this from the **repo root**, not from `apps/web/`.

```bash
git add apps/web/package.json apps/web/vite.config.ts bun.lock
git commit -m "chore: add mermaid dependency and exclude from Vite pre-bundling (#256)"
```

### Task 5: Create MermaidBlock component

**Files:**
- Create: `apps/web/src/components/chat/MermaidBlock.tsx`
- Test: `apps/web/src/__tests__/MermaidBlock.test.tsx` (new)

- [ ] **Step 1: Write failing tests for MermaidBlock**

Create `apps/web/src/__tests__/MermaidBlock.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

// Mock mermaid
const mockRender = vi.fn();
const mockInitialize = vi.fn();
vi.mock("mermaid", () => ({
  default: {
    initialize: (...args: unknown[]) => mockInitialize(...args),
    render: (...args: unknown[]) => mockRender(...args),
  },
}));

// Mock useTheme
vi.mock("../hooks/useTheme", () => ({
  useShikiTheme: vi.fn(() => "github-dark"),
}));

// Mock CodeBlock
vi.mock("../components/chat/CodeBlock", () => ({
  CodeBlock: ({ code, language }: { code: string; language: string }) => (
    <pre data-testid="code-block" data-language={language}>{code}</pre>
  ),
}));

import MermaidBlock from "../components/chat/MermaidBlock";

describe("MermaidBlock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRender.mockResolvedValue({ svg: '<svg class="mermaid">diagram</svg>' });
  });

  it("renders raw code when streaming", () => {
    render(<MermaidBlock code="graph TD; A-->B;" isStreaming={true} />);
    expect(screen.getByText("graph TD; A-->B;")).toBeInTheDocument();
    expect(mockRender).not.toHaveBeenCalled();
  });

  it("renders nothing for empty code", () => {
    const { container } = render(<MermaidBlock code="   " isStreaming={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("calls mermaid.render when not streaming", async () => {
    render(<MermaidBlock code="graph TD; A-->B;" isStreaming={false} />);
    await waitFor(() => {
      expect(mockRender).toHaveBeenCalledWith(
        expect.stringContaining("mermaid-"),
        "graph TD; A-->B;",
      );
    });
  });

  it("renders SVG output after mermaid.render resolves", async () => {
    mockRender.mockResolvedValue({ svg: '<svg data-testid="mermaid-svg">test</svg>' });
    const { container } = render(<MermaidBlock code="graph TD; A-->B;" isStreaming={false} />);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='mermaid-svg']")).toBeInTheDocument();
    });
  });

  it("falls back to CodeBlock with error banner on render failure", async () => {
    mockRender.mockRejectedValue(new Error("Parse error"));
    render(<MermaidBlock code="invalid mermaid" isStreaming={false} />);
    await waitFor(() => {
      expect(screen.getByText(/diagram could not be rendered/i)).toBeInTheDocument();
      expect(screen.getByTestId("code-block")).toBeInTheDocument();
    });
  });

  it("initializes mermaid with securityLevel strict", async () => {
    render(<MermaidBlock code="graph TD; A-->B;" isStreaming={false} />);
    await waitFor(() => {
      expect(mockInitialize).toHaveBeenCalledWith(
        expect.objectContaining({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "dark",
        }),
      );
    });
  });

  it("toggles between diagram and code view", async () => {
    mockRender.mockResolvedValue({ svg: '<svg>diagram</svg>' });
    render(<MermaidBlock code="graph TD; A-->B;" isStreaming={false} />);

    // Wait for diagram to render
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /view code/i })).toBeInTheDocument();
    });

    // Switch to code view
    fireEvent.click(screen.getByRole("button", { name: /view code/i }));
    expect(screen.getByTestId("code-block")).toBeInTheDocument();

    // Switch back to diagram view
    fireEvent.click(screen.getByRole("button", { name: /view diagram/i }));
    await waitFor(() => {
      expect(screen.queryByTestId("code-block")).not.toBeInTheDocument();
    });
  });

  it("copy button copies raw mermaid source", async () => {
    mockRender.mockResolvedValue({ svg: '<svg>diagram</svg>' });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<MermaidBlock code="graph TD; A-->B;" isStreaming={false} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("graph TD; A-->B;");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run src/__tests__/MermaidBlock.test.tsx`
Expected: FAIL - `MermaidBlock` module not found

- [ ] **Step 3: Create MermaidBlock component**

Create `apps/web/src/components/chat/MermaidBlock.tsx`:

```tsx
import { memo, useState, useEffect, useCallback, useRef, useId } from "react";
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

type RenderState =
  | { status: "loading" }
  | { status: "success"; svg: string }
  | { status: "error"; message: string };

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
    lastInitTheme = theme;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme,
    });
  }
  return mermaid;
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
 * sanitizes SVG with its bundled DOMPurify, and securityLevel is set to "strict".
 */
const MermaidBlock = memo(function MermaidBlock({ code, isStreaming }: MermaidBlockProps) {
  const shikiTheme = useShikiTheme();
  const mermaidTheme = toMermaidTheme(shikiTheme);
  const rawId = useId();
  const mermaidId = "mermaid-" + rawId.replace(/:/g, "");

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
        if (!cancelled) {
          setState({
            status: "error",
            message: err instanceof Error ? err.message : "Diagram could not be rendered",
          });
        }
      }
    })();

    return () => { cancelled = true; };
  }, [code, mermaidTheme, mermaidId, isStreaming]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard write failed
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run src/__tests__/MermaidBlock.test.tsx`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/chat/MermaidBlock.tsx apps/web/src/__tests__/MermaidBlock.test.tsx
git commit -m "feat: add MermaidBlock component with diagram/code toggle (#256)"
```

---

## Chunk 5: Wire Mermaid into MarkdownContent

### Task 6: Add mermaid language fork in MarkdownContent

**Files:**
- Modify: `apps/web/src/components/chat/MarkdownContent.tsx:1-4`
- Test: `apps/web/src/__tests__/MarkdownContent.test.tsx`

- [ ] **Step 1: Write failing tests for mermaid routing**

Add to the top of `apps/web/src/__tests__/MarkdownContent.test.tsx` (with existing mocks):

```tsx
// Add this mock alongside existing mocks
vi.mock("../components/chat/MermaidBlock", () => ({
  default: ({ code, isStreaming }: { code: string; isStreaming: boolean }) => (
    <div data-testid="mermaid-block" data-streaming={isStreaming}>{code}</div>
  ),
}));
```

Add `waitFor` to the existing `@testing-library/react` import (keep `fireEvent` which is used by the link tests):

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
```

Add these test cases:

```tsx
describe("mermaid code blocks", () => {
  it("routes mermaid language to MermaidBlock", async () => {
    render(
      <MarkdownContent content={'```mermaid\ngraph TD; A-->B;\n```'} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("mermaid-block")).toBeInTheDocument();
      expect(screen.getByTestId("mermaid-block")).toHaveTextContent("graph TD; A-->B;");
    });
  });

  it("passes isStreaming to MermaidBlock", async () => {
    render(
      <MarkdownContent content={'```mermaid\ngraph TD;\n```'} isStreaming={true} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("mermaid-block")).toHaveAttribute("data-streaming", "true");
    });
  });

  it("routes non-mermaid languages to CodeBlock", () => {
    render(
      <MarkdownContent content={'```python\nprint("hi")\n```'} />,
    );
    expect(screen.getByTestId("code-block")).toBeInTheDocument();
    expect(screen.queryByTestId("mermaid-block")).not.toBeInTheDocument();
  });

  it("routes mermaid to MermaidBlock in user variant too", async () => {
    render(
      <MarkdownContent content={'```mermaid\ngraph LR; X-->Y;\n```'} variant="user" />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("mermaid-block")).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run src/__tests__/MarkdownContent.test.tsx`
Expected: FAIL - mermaid blocks route to CodeBlock, not MermaidBlock

- [ ] **Step 3: Add mermaid fork to MarkdownContent**

In `apps/web/src/components/chat/MarkdownContent.tsx`:

Update the import on line 1 to add `lazy` and `Suspense`:

```tsx
import { memo, useMemo, lazy, Suspense } from "react";
```

Add `LazyMermaidBlock` after the `plugins` declaration:

```tsx
/** Lazy-loaded MermaidBlock - only fetched when a mermaid fence is encountered. */
const LazyMermaidBlock = lazy(() => import("./MermaidBlock"));
```

In the `makeComponents` function's `code` handler, add the mermaid fork after the `plan-questions` check and before the final `CodeBlock` return:

```tsx
      if (language === "mermaid") {
        return (
          <Suspense fallback={
            <pre className="bg-muted/30 rounded-lg p-4 overflow-x-auto"><code>{code}</code></pre>
          }>
            <LazyMermaidBlock code={code} isStreaming={isStreaming} />
          </Suspense>
        );
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run src/__tests__/MarkdownContent.test.tsx`
Expected: All tests PASS

- [ ] **Step 5: Run all chat component tests**

Run: `cd apps/web && npx vitest run src/__tests__/CodeBlock.test.tsx src/__tests__/MarkdownContent.test.tsx src/__tests__/MermaidBlock.test.tsx`
Expected: All tests PASS

- [ ] **Step 6: Typecheck all packages**

```bash
(cd apps/server && npx tsc --noEmit) && (cd apps/web && npx tsc --noEmit) && (cd apps/desktop && npx tsc --noEmit)
```

Expected: No type errors

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/chat/MarkdownContent.tsx apps/web/src/__tests__/MarkdownContent.test.tsx
git commit -m "feat: route mermaid code blocks to MermaidBlock in MarkdownContent (#256)"
```

---

## Chunk 6: Final Integration Verification

### Task 7: Full test suite and typecheck

**Files:** None (verification only)

- [ ] **Step 1: Run full web test suite**

Run: `cd apps/web && npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Typecheck all packages**

```bash
(cd apps/server && npx tsc --noEmit) && (cd apps/web && npx tsc --noEmit) && (cd apps/desktop && npx tsc --noEmit)
```

Expected: No type errors in any package

- [ ] **Step 3: Verify dev server starts**

Run: `cd apps/web && npx vite --force` (briefly, verify no crash on startup)
Expected: Vite dev server starts, no mermaid-related errors in console

- [ ] **Step 4: Final commit - update spec status**

In `docs/specs/2026-04-13-md-rendering-mermaid-design.md`, change `**Status:** Draft` to `**Status:** Implemented`.

```bash
git add docs/specs/2026-04-13-md-rendering-mermaid-design.md
git commit -m "docs: mark md rendering spec as implemented (#256)"
```
