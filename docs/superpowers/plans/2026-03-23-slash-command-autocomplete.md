# Slash Command Autocomplete Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a floating slash-command autocomplete popup to the Composer that discovers user Claude SDK skills and mcode built-in commands.

**Architecture:** A `useSlashCommand` hook owns all trigger detection, filtering, keyboard navigation, and IPC caching. A `SlashCommandPopup` component renders the dropdown. The Composer mounts both and delegates the `/m:plan` side-effect via a callback.

**Tech Stack:** TypeScript, React, Vitest, Electron IPC (`ipcMain.handle`), Node.js `fs.readdirSync`, `@tanstack/react-virtual` (already in `apps/web/package.json`)

**Spec:** `docs/superpowers/specs/2026-03-23-slash-command-autocomplete-design.md`

---

## Chunk 1: Backend IPC + Transport Layer

### Task 1: Extract `listSkills` to a testable module

**Files:**
- Create: `apps/desktop/src/main/skills.ts`
- Create: `apps/desktop/src/main/__tests__/skills.test.ts`
- Modify: `apps/desktop/src/main/index.ts` (line ~247, after `list-worktrees` handler)

---

- [ ] **Step 1.1: Write the failing test**

Create `apps/desktop/src/main/__tests__/skills.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Dirent } from "fs";

vi.mock("fs", () => ({
  readdirSync: vi.fn(),
}));
vi.mock("os", () => ({
  homedir: vi.fn(),
}));

import { listSkills } from "../skills.js";
import { readdirSync } from "fs";
import { homedir } from "os";

function makeDirent(name: string, isDir: boolean): Dirent {
  return { name, isDirectory: () => isDir } as unknown as Dirent;
}

describe("listSkills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(homedir).mockReturnValue("/home/test");
  });

  it("returns skill names from subdirectories of ~/.claude/skills/", () => {
    vi.mocked(readdirSync).mockReturnValue([
      makeDirent("commit", true),
      makeDirent("review-pr", true),
      makeDirent("tdd", true),
    ] as unknown as ReturnType<typeof readdirSync>);

    expect(listSkills()).toEqual(["commit", "review-pr", "tdd"]);
  });

  it("ignores files (non-directories)", () => {
    vi.mocked(readdirSync).mockReturnValue([
      makeDirent("commit", true),
      makeDirent("README.md", false),
    ] as unknown as ReturnType<typeof readdirSync>);

    expect(listSkills()).toEqual(["commit"]);
  });

  it("returns [] when ~/.claude/skills/ does not exist", () => {
    vi.mocked(readdirSync).mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    expect(listSkills()).toEqual([]);
  });

  it("returns [] when ~/.claude/skills/ exists but is empty", () => {
    vi.mocked(readdirSync).mockReturnValue([]);
    expect(listSkills()).toEqual([]);
  });
});
```

- [ ] **Step 1.2: Run test — expect FAIL**

```bash
cd apps/desktop && bun run test -- --reporter=verbose 2>&1 | grep -E "FAIL|PASS|Error" | head -10
```

Expected: FAIL with `Cannot find module '../skills.js'`

- [ ] **Step 1.3: Implement `skills.ts`**

Create `apps/desktop/src/main/skills.ts`:

```ts
import { readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/**
 * List available Claude SDK skills by scanning subdirectory names under
 * ~/.claude/skills/. Returns [] if the directory does not exist.
 */
export function listSkills(): string[] {
  const skillsDir = join(homedir(), ".claude", "skills");
  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}
```

- [ ] **Step 1.4: Run test — expect PASS**

```bash
cd apps/desktop && bun run test -- --reporter=verbose 2>&1 | grep -E "FAIL|PASS|✓|✗" | head -20
```

Expected: all 4 `listSkills` tests pass.

- [ ] **Step 1.5: Register the IPC handler**

In `apps/desktop/src/main/index.ts`, import `listSkills` at the top with the other local imports:

```ts
import { listSkills } from "./skills.js";
```

Then add the IPC handler inside `registerIpcHandlers`, after the `list-worktrees` handler (line ~248):

```ts
  ipcMain.handle("list-skills", () => {
    return listSkills();
  });
```

- [ ] **Step 1.6: Commit**

```bash
git add apps/desktop/src/main/skills.ts \
        apps/desktop/src/main/__tests__/skills.test.ts \
        apps/desktop/src/main/index.ts
git commit -m "feat: add list-skills IPC handler"
```

> **Note on IPC handler testing:** The handler in `index.ts` (`ipcMain.handle("list-skills", () => listSkills())`) is a pure passthrough with no logic. Unit testing `listSkills()` in `skills.test.ts` provides full coverage. An integration test of the handler itself would require spinning up an Electron main process and is out of scope for this plan. Verify the IPC wiring manually during the Step 6 smoke test.

---

### Task 2: Add `listSkills` to the transport layer

**Files:**
- Modify: `apps/web/src/transport/types.ts` (after line 155, before closing `}`)
- Modify: `apps/web/src/transport/electron.ts` (add method to returned object)
- Modify: `apps/web/src/transport/tauri.ts` (add stub)
- Modify: `apps/web/src/transport/index.ts` (add stub to `createMockTransport`)
- Modify: `apps/web/src/__tests__/mocks/transport.ts` (add to `mockTransport`)

---

- [ ] **Step 2.1: Add `listSkills` to `McodeTransport` interface**

In `apps/web/src/transport/types.ts`, add after the `getVersion` line (line 155):

```ts
  // Skills
  listSkills(): Promise<string[]>;
```

> **Important:** Steps 2.2-2.5 must ALL be completed before running Step 2.6 (`bun run typecheck`). Adding the method to the interface makes the TypeScript compiler require it on every transport implementation. If any of the four targets (electron, tauri, createMockTransport, mockTransport) is missing the method, typecheck will fail with a missing property error on that specific object.

- [ ] **Step 2.2: Implement in `electron.ts`**

In `apps/web/src/transport/electron.ts`, add after the `getVersion` method:

```ts
    async listSkills() {
      return api.invoke("list-skills") as Promise<string[]>;
    },
```

- [ ] **Step 2.3: Add stub to `tauri.ts`**

In `apps/web/src/transport/tauri.ts`, add after `readClipboardImage` (before the closing `}`):

```ts
    async listSkills() {
      throw new Error("Not implemented in Tauri");
    },
```

- [ ] **Step 2.4: Add stub to `createMockTransport()` in `index.ts`**

In `apps/web/src/transport/index.ts`, inside `createMockTransport()`, add after `readClipboardImage`:

```ts
    async listSkills() { return []; },
```

- [ ] **Step 2.5: Update `mockTransport` in test mocks**

In `apps/web/src/__tests__/mocks/transport.ts`, add after `readClipboardImage`:

```ts
  listSkills: vi.fn().mockResolvedValue([]),
```

- [ ] **Step 2.6: Verify TypeScript compiles**

```bash
cd apps/web && bun run typecheck 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 2.7: Run tests**

```bash
cd apps/web && bun run test -- --reporter=verbose 2>&1 | grep -E "FAIL|PASS" | head -10
```

Expected: all existing tests still pass.

- [ ] **Step 2.8: Commit**

```bash
git add apps/web/src/transport/types.ts \
        apps/web/src/transport/electron.ts \
        apps/web/src/transport/tauri.ts \
        apps/web/src/transport/index.ts \
        apps/web/src/__tests__/mocks/transport.ts
git commit -m "feat: add listSkills to transport layer"
```

---

## Chunk 2: `useSlashCommand` Hook

### Task 3: Implement the hook

**Files:**
- Create: `apps/web/src/components/chat/useSlashCommand.ts`
- Create: `apps/web/src/__tests__/slash-command.test.ts`

---

- [ ] **Step 3.1: Write the failing tests**

Create `apps/web/src/__tests__/slash-command.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Mock transport so IPC doesn't run
vi.mock("@/transport", () => ({
  getTransport: vi.fn(() => ({
    listSkills: vi.fn().mockResolvedValue(["commit", "review-pr", "tdd"]),
  })),
}));

import { useSlashCommand } from "@/components/chat/useSlashCommand";
import { getTransport } from "@/transport";

beforeEach(() => {
  vi.clearAllMocks();
});

function makeTextarea(value = "", selectionStart = value.length) {
  return {
    current: {
      value,
      selectionStart,
      getBoundingClientRect: () => ({
        top: 100, left: 0, bottom: 130, right: 400,
        width: 400, height: 30,
      } as DOMRect),
    },
  } as React.RefObject<HTMLTextAreaElement>;
}

describe("trigger detection", () => {
  it("opens on '/' at the start", async () => {
    const ref = makeTextarea("/");
    const { result } = renderHook(() =>
      useSlashCommand({ textareaRef: ref })
    );
    await act(async () => {
      result.current.onInputChange("/");
    });
    expect(result.current.isOpen).toBe(true);
  });

  it("opens on '/' after whitespace", async () => {
    const ref = makeTextarea("hello /");
    const { result } = renderHook(() =>
      useSlashCommand({ textareaRef: ref })
    );
    await act(async () => {
      result.current.onInputChange("hello /");
    });
    expect(result.current.isOpen).toBe(true);
  });

  it("does NOT open on '/' mid-word", async () => {
    const ref = makeTextarea("abc/def");
    const { result } = renderHook(() =>
      useSlashCommand({ textareaRef: ref })
    );
    await act(async () => {
      result.current.onInputChange("abc/def");
    });
    expect(result.current.isOpen).toBe(false);
  });

  it("closes when trigger text is deleted", async () => {
    const ref = makeTextarea("/");
    const { result } = renderHook(() =>
      useSlashCommand({ textareaRef: ref })
    );
    await act(async () => {
      result.current.onInputChange("/");
    });
    expect(result.current.isOpen).toBe(true);

    ref.current!.value = "";
    ref.current!.selectionStart = 0;
    await act(async () => {
      result.current.onInputChange("");
    });
    expect(result.current.isOpen).toBe(false);
  });
});

describe("filter logic", () => {
  it("shows all items on bare '/'", async () => {
    const ref = makeTextarea("/");
    const { result } = renderHook(() =>
      useSlashCommand({ textareaRef: ref })
    );
    await act(async () => {
      result.current.onInputChange("/");
    });
    // Wait for async skill load
    await act(async () => {});
    // Should contain mcode commands + loaded skills
    expect(result.current.items.length).toBeGreaterThan(0);
  });

  it("filters case-insensitively by substring", async () => {
    const ref = makeTextarea("/REV");
    const { result } = renderHook(() =>
      useSlashCommand({ textareaRef: ref })
    );
    await act(async () => {
      result.current.onInputChange("/REV");
    });
    await act(async () => {});
    const names = result.current.items.map((i) => i.name);
    expect(names).toContain("review-pr");
    expect(names).not.toContain("commit");
  });

  it("matches mcode commands by name without 'm:' prefix in filter", async () => {
    const ref = makeTextarea("/pla");
    const { result } = renderHook(() =>
      useSlashCommand({ textareaRef: ref })
    );
    await act(async () => {
      result.current.onInputChange("/pla");
    });
    await act(async () => {});
    const names = result.current.items.map((i) => i.name);
    expect(names).toContain("m:plan");
  });
});

describe("keyboard navigation", () => {
  it("ArrowDown increments selectedIndex", async () => {
    const ref = makeTextarea("/");
    const { result } = renderHook(() =>
      useSlashCommand({ textareaRef: ref })
    );
    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {}); // flush skill load

    expect(result.current.selectedIndex).toBe(0);
    await act(async () => {
      result.current.onKeyDown({
        key: "ArrowDown",
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
    });
    expect(result.current.selectedIndex).toBe(1);
  });

  it("Escape closes the popup", async () => {
    const ref = makeTextarea("/");
    const { result } = renderHook(() =>
      useSlashCommand({ textareaRef: ref })
    );
    await act(async () => { result.current.onInputChange("/"); });
    expect(result.current.isOpen).toBe(true);

    await act(async () => {
      result.current.onKeyDown({
        key: "Escape",
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
    });
    expect(result.current.isOpen).toBe(false);
  });
});

describe("selection + text replacement", () => {
  it("onSelect replaces the trigger text in the input", async () => {
    const ref = makeTextarea("/com");
    const { result } = renderHook(() =>
      useSlashCommand({ textareaRef: ref })
    );
    await act(async () => { result.current.onInputChange("/com"); });
    await act(async () => {});

    let emittedValue = "";
    await act(async () => {
      result.current.onSelect(
        { name: "commit", description: "Commit changes", namespace: "skill" },
        (v: string) => { emittedValue = v; }
      );
    });
    expect(emittedValue).toBe("/commit ");
    expect(result.current.isOpen).toBe(false);
  });
});

describe("mcode side-effect dispatch", () => {
  it("calls onMcodeCommand with the action when an mcode command is selected", async () => {
    const ref = makeTextarea("/m:pla");
    const onMcodeCommand = vi.fn();
    const { result } = renderHook(() =>
      useSlashCommand({ textareaRef: ref, onMcodeCommand })
    );
    await act(async () => { result.current.onInputChange("/m:pla"); });
    await act(async () => {});

    const planCmd = result.current.items.find((i) => i.name === "m:plan");
    expect(planCmd).toBeDefined();

    await act(async () => {
      result.current.onSelect(planCmd!, (_v: string) => {});
    });
    expect(onMcodeCommand).toHaveBeenCalledWith("toggle-plan");
  });
});

describe("IPC cache", () => {
  it("calls listSkills only once across multiple trigger openings", async () => {
    const mockListSkills = vi.fn().mockResolvedValue(["commit"]);
    vi.mocked(getTransport).mockReturnValue({ listSkills: mockListSkills } as never);

    const ref = makeTextarea("/");
    const { result } = renderHook(() =>
      useSlashCommand({ textareaRef: ref })
    );

    // Open popup twice
    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});
    await act(async () => { result.current.onInputChange(""); });
    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    expect(mockListSkills).toHaveBeenCalledTimes(1);
  });
});
```

> **Note:** The `onInputChange` and `onSelect` signatures above define the hook's public API.
> `onSelect` receives the command AND a callback `(newValue: string) => void` that the Composer passes to update input state.

- [ ] **Step 3.2: Run test — expect FAIL**

```bash
cd apps/web && bun run test -- slash-command --reporter=verbose 2>&1 | grep -E "FAIL|PASS|Error" | head -10
```

Expected: FAIL with `Cannot find module '@/components/chat/useSlashCommand'`

- [ ] **Step 3.3: Implement `useSlashCommand.ts`**

Create `apps/web/src/components/chat/useSlashCommand.ts`:

```ts
import { useState, useRef, useCallback } from "react";
import { getTransport } from "@/transport";

export interface Command {
  name: string;
  description: string;
  namespace: "skill" | "mcode";
  action?: string;
}

const MCODE_COMMANDS: Command[] = [
  {
    name: "m:plan",
    description: "Toggle plan mode",
    namespace: "mcode",
    action: "toggle-plan",
  },
];

/** Regex: matches `/` at start of line or after whitespace, followed by non-space chars. */
const TRIGGER_RE = /(^|\s)(\/\S*)$/;

interface UseSlashCommandOptions {
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  onMcodeCommand?: (action: string) => void;
}

export interface UseSlashCommandReturn {
  isOpen: boolean;
  isLoading: boolean;
  items: Command[];
  selectedIndex: number;
  anchorRect: DOMRect | null;
  onInputChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSelect: (cmd: Command, setInput: (v: string) => void) => void;
  onDismiss: () => void;
}

export function useSlashCommand({
  textareaRef,
  onMcodeCommand,
}: UseSlashCommandOptions): UseSlashCommandReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [items, setItems] = useState<Command[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  // Cache: loaded skills + timestamp for TTL
  const skillsCache = useRef<{ names: string[]; fetchedAt: number } | null>(null);
  const CACHE_TTL_MS = 5 * 60 * 1000;

  const loadSkills = useCallback(async (): Promise<string[]> => {
    const now = Date.now();
    if (skillsCache.current && now - skillsCache.current.fetchedAt < CACHE_TTL_MS) {
      return skillsCache.current.names;
    }
    const names = await getTransport().listSkills();
    skillsCache.current = { names, fetchedAt: now };
    return names;
  }, []);

  const buildItems = useCallback((skillNames: string[], filter: string): Command[] => {
    const f = filter.toLowerCase();
    const skills: Command[] = skillNames.map((name) => ({
      name,
      description: `Run /${name}`,
      namespace: "skill" as const,
    }));
    const all = [...MCODE_COMMANDS, ...skills];
    if (!f) return all;
    return all.filter((cmd) => cmd.name.toLowerCase().includes(f));
  }, []);

  const onInputChange = useCallback(
    (value: string) => {
      const textarea = textareaRef.current;
      const cursor = textarea?.selectionStart ?? value.length;
      const before = value.slice(0, cursor);
      const match = TRIGGER_RE.exec(before);

      if (!match) {
        setIsOpen(false);
        return;
      }

      // Update anchor on every change while popup is open
      if (textarea) {
        setAnchorRect(textarea.getBoundingClientRect());
      }

      // Filter text is the matched group minus the leading '/'
      const triggerText = match[2]; // e.g. "/com"
      const filter = triggerText.slice(1); // e.g. "com"

      setIsOpen(true);
      setSelectedIndex(0);

      if (!skillsCache.current) {
        setIsLoading(true);
        loadSkills().then((names) => {
          setIsLoading(false);
          setItems(buildItems(names, filter));
        });
      } else {
        setItems(buildItems(skillsCache.current.names, filter));
        // Background refresh if TTL expired
        if (Date.now() - skillsCache.current.fetchedAt >= CACHE_TTL_MS) {
          loadSkills().then((names) => {
            setItems(buildItems(names, filter));
          });
        }
      }
    },
    [textareaRef, loadSkills, buildItems],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!isOpen) return;

      // Enter and Tab are handled by the Composer (it calls onSelect directly).
      // The hook handles only navigation and dismiss.
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          setIsOpen(false);
          break;
      }
    },
    [isOpen, items],
  );

  const onSelect = useCallback(
    (cmd: Command, setInput: (v: string) => void) => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      const value = textarea.value;
      const cursor = textarea.selectionStart ?? value.length;
      const before = value.slice(0, cursor);
      const match = TRIGGER_RE.exec(before);

      if (match) {
        const triggerStart = before.lastIndexOf(match[2]);
        const newValue =
          value.slice(0, triggerStart) + `/${cmd.name} ` + value.slice(cursor);
        setInput(newValue);
      }

      if (cmd.action && onMcodeCommand) {
        onMcodeCommand(cmd.action);
      }

      setIsOpen(false);
    },
    [textareaRef, onMcodeCommand],
  );

  const onDismiss = useCallback(() => setIsOpen(false), []);

  return {
    isOpen,
    isLoading,
    items,
    selectedIndex,
    anchorRect,
    onInputChange,
    onKeyDown,
    onSelect,
    onDismiss,
  };
}
```

- [ ] **Step 3.4: Run tests — expect PASS**

```bash
cd apps/web && bun run test -- slash-command --reporter=verbose 2>&1 | grep -E "FAIL|PASS|✓|✗" | head -30
```

Expected: all hook tests pass.

> **If `Enter`/`Tab` key tests fail:** The hook signals intent on keydown but the actual selection is triggered from the caller. Adjust tests to match the separation of concerns (keydown marks pending, Composer calls `onSelect`). See Step 5 for Composer wiring.

- [ ] **Step 3.5: Commit**

```bash
git add apps/web/src/components/chat/useSlashCommand.ts \
        apps/web/src/__tests__/slash-command.test.ts
git commit -m "feat: add useSlashCommand hook with trigger detection, filtering, and caching"
```

---

## Chunk 3: Popup Component + Composer Integration

### Task 4: `SlashCommandPopup` component

**Files:**
- Create: `apps/web/src/components/chat/SlashCommandPopup.tsx`

---

- [ ] **Step 4.1: Implement `SlashCommandPopup.tsx`**

Create `apps/web/src/components/chat/SlashCommandPopup.tsx`:

```tsx
import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";
import { Terminal, Zap } from "lucide-react";
import type { Command } from "./useSlashCommand";

const ITEM_HEIGHT = 44; // px per row
const VISIBLE_ITEMS = 8;
const VIRTUAL_THRESHOLD = 20; // use virtual scroll only above this count

interface SlashCommandPopupProps {
  isOpen: boolean;
  isLoading: boolean;
  items: Command[];
  selectedIndex: number;
  anchorRect: DOMRect | null;
  onSelect: (cmd: Command) => void;
  onDismiss: () => void;
}

export function SlashCommandPopup({
  isOpen,
  isLoading,
  items,
  selectedIndex,
  anchorRect,
  onSelect,
  onDismiss,
}: SlashCommandPopupProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: items.length > VIRTUAL_THRESHOLD ? items.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ITEM_HEIGHT,
    overscan: 2,
  });

  // Scroll selected item into view
  useEffect(() => {
    if (!isOpen) return;
    if (items.length > VIRTUAL_THRESHOLD) {
      virtualizer.scrollToIndex(selectedIndex, { align: "auto" });
    } else {
      const el = scrollRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, isOpen, items.length, virtualizer]);

  // Dismiss on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (!(e.target as Element).closest("[data-slash-popup]")) {
        onDismiss();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen, onDismiss]);

  if (!isOpen || !anchorRect) return null;

  // Position: default above the anchor rect, flip below if not enough space
  const spaceAbove = anchorRect.top;
  const maxHeight = Math.min(VISIBLE_ITEMS * ITEM_HEIGHT, items.length * ITEM_HEIGHT || ITEM_HEIGHT * 2);
  const placeAbove = spaceAbove > maxHeight + 8;

  const style: React.CSSProperties = {
    position: "fixed",
    left: anchorRect.left,
    width: Math.max(anchorRect.width, 320),
    maxHeight,
    ...(placeAbove
      ? { bottom: window.innerHeight - anchorRect.top + 4 }
      : { top: anchorRect.bottom + 4 }),
  };

  const useVirtual = items.length > VIRTUAL_THRESHOLD;

  return (
    <div
      data-slash-popup
      style={style}
      className={cn(
        "z-50 overflow-hidden rounded-lg border border-border bg-card shadow-lg",
        "animate-in fade-in-0 zoom-in-95 duration-[120ms]",
      )}
    >
      {isLoading ? (
        <SkeletonRows />
      ) : items.length === 0 ? (
        <EmptyState />
      ) : (
        <div
          ref={scrollRef}
          style={{ maxHeight, overflowY: "auto" }}
        >
          {useVirtual ? (
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((vi) => (
                <div
                  key={vi.key}
                  style={{ position: "absolute", top: vi.start, width: "100%", height: vi.size }}
                  data-index={vi.index}
                >
                  <CommandRow
                    cmd={items[vi.index]}
                    selected={vi.index === selectedIndex}
                    onSelect={onSelect}
                  />
                </div>
              ))}
            </div>
          ) : (
            items.map((cmd, i) => (
              <div key={cmd.name} data-index={i}>
                <CommandRow
                  cmd={cmd}
                  selected={i === selectedIndex}
                  onSelect={onSelect}
                />
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function CommandRow({
  cmd,
  selected,
  onSelect,
}: {
  cmd: Command;
  selected: boolean;
  onSelect: (cmd: Command) => void;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => {
        e.preventDefault(); // prevent textarea blur
        onSelect(cmd);
      }}
      className={cn(
        "flex w-full items-center gap-3 px-3 py-2 text-left transition-colors",
        selected
          ? "bg-accent border-l-2 border-primary"
          : "hover:bg-accent/50 border-l-2 border-transparent",
      )}
    >
      {/* Icon column */}
      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-muted-foreground">
        {cmd.namespace === "mcode" ? (
          <Zap size={12} />
        ) : (
          <Terminal size={12} />
        )}
      </span>

      {/* Name + description */}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">
          /{cmd.name}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {cmd.description}
        </span>
      </span>

      {/* Namespace badge */}
      <span
        className={cn(
          "ml-auto flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
          cmd.namespace === "mcode"
            ? "bg-primary/15 text-primary"
            : "bg-muted text-muted-foreground",
        )}
      >
        {cmd.namespace === "mcode" ? "mcode" : "skill"}
      </span>
    </button>
  );
}

function SkeletonRows() {
  return (
    <div className="p-1">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-2">
          <div className="h-5 w-5 rounded bg-muted animate-pulse" />
          <div className="flex flex-1 flex-col gap-1">
            <div className="h-3 w-24 rounded bg-muted animate-pulse" />
            <div className="h-2 w-40 rounded bg-muted animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <span className="flex h-5 w-5 flex-shrink-0" /> {/* icon placeholder */}
      <span className="text-sm text-muted-foreground">No commands match</span>
    </div>
  );
}
```

- [ ] **Step 4.2: Verify TypeScript compiles**

```bash
cd apps/web && bun run typecheck 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 4.3: Commit**

```bash
git add apps/web/src/components/chat/SlashCommandPopup.tsx
git commit -m "feat: add SlashCommandPopup component"
```

---

### Task 5: Wire up in Composer

**Files:**
- Modify: `apps/web/src/components/chat/Composer.tsx`

---

- [ ] **Step 5.1: Add imports to `Composer.tsx`**

At the top of `apps/web/src/components/chat/Composer.tsx`, after the existing local imports (line ~26):

```ts
import { useSlashCommand } from "./useSlashCommand";
import { SlashCommandPopup } from "./SlashCommandPopup";
```

- [ ] **Step 5.2: Initialise the hook**

Inside the `Composer` function body, after the existing `useRef` and `useState` calls (after line ~58), add:

```tsx
const autocomplete = useSlashCommand({
  textareaRef,
  onMcodeCommand: (action) => {
    if (action === "toggle-plan") {
      const next =
        mode === INTERACTION_MODES.PLAN
          ? INTERACTION_MODES.CHAT
          : INTERACTION_MODES.PLAN;
      setMode(next);
      if (threadId) setThreadSettings(threadId, { interactionMode: next });
    }
  },
});
```

- [ ] **Step 5.3: Update `handleInputChange` to notify the hook**

Replace the existing `handleInputChange` (lines ~366–371):

```tsx
const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
  const value = e.target.value;
  setInput(value);
  autocomplete.onInputChange(value);
  const el = e.target;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 200) + "px";
};
```

- [ ] **Step 5.4: Update `handleKeyDown` to delegate to the hook**

Replace the existing `handleKeyDown` (lines ~356–363):

```tsx
const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
  // When the popup is open, intercept Enter/Tab for selection BEFORE
  // any other handler sees them. This prevents Enter from also sending
  // the message while the popup is visible.
  if (autocomplete.isOpen) {
    if (e.key === "Enter" || e.key === "Tab") {
      const cmd = autocomplete.items[autocomplete.selectedIndex];
      if (cmd) {
        e.preventDefault();
        e.stopPropagation();
        autocomplete.onSelect(cmd, setInput);
        return;
      }
    }
    // ArrowUp/ArrowDown/Escape: delegate to hook
    autocomplete.onKeyDown(e);
    if (e.defaultPrevented) return;
  }

  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (isAgentRunning) return;
    handleSend();
  }
  // Shift+Enter: natural newline — no action needed
};
```

- [ ] **Step 5.5: Render the popup in JSX**

Inside the returned JSX, add the popup as the last child of the outermost `<div>` (after the `/* Status bar */` div, before the closing `</div>`):

```tsx
      <SlashCommandPopup
        isOpen={autocomplete.isOpen}
        isLoading={autocomplete.isLoading}
        items={autocomplete.items}
        selectedIndex={autocomplete.selectedIndex}
        anchorRect={autocomplete.anchorRect}
        onSelect={(cmd) => autocomplete.onSelect(cmd, setInput)}
        onDismiss={autocomplete.onDismiss}
      />
```

- [ ] **Step 5.6: Verify TypeScript compiles**

```bash
cd apps/web && bun run typecheck 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 5.7: Run full test suite**

```bash
bun run test 2>&1 | tail -20
```

Expected: all existing tests pass. Hook tests pass. No regressions.

- [ ] **Step 5.8: Commit**

```bash
git add apps/web/src/components/chat/Composer.tsx
git commit -m "feat: wire slash command autocomplete into Composer"
```

---

## Chunk 4: Smoke Test + Final Checks

### Task 6: Manual verification checklist

> Run `bun run dev` from the repo root and verify in the Electron app:

- [ ] **6.1** Type `/` at the start of the composer input — popup opens.
- [ ] **6.2** Type `/com` — list filters to only commands containing "com".
- [ ] **6.3** Arrow keys navigate the list. Enter selects and inserts the command text.
- [ ] **6.4** Tab selects. Escape closes without inserting.
- [ ] **6.5** Click an item — it inserts the command text.
- [ ] **6.6** Type `/m:pla` — `/m:plan` appears in the list. Selecting it inserts `/m:plan ` and the composer toolbar shows "Plan" mode.
- [ ] **6.7** If already in plan mode, typing `/m:plan` and selecting it switches back to "Chat" mode.
- [ ] **6.8** Type `hello /` (space before `/`) — popup opens.
- [ ] **6.9** Type `abc/def` (no space) — popup stays closed.
- [ ] **6.10** Open popup, wait >5 min, type `/` again — skill list re-fetches (verify in DevTools Network or add a console.log temporarily).

### Task 7: Final typecheck and test gate

- [ ] **Step 7.1: Full typecheck**

```bash
bun run typecheck 2>&1 | tail -10
```

Expected: no errors.

- [ ] **Step 7.2: Full test run**

```bash
bun run test 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 7.3: Close issue**

```bash
gh issue close 17 --comment "Implemented in this branch. Slash command autocomplete ships with /m:plan toggle and full Claude SDK skill discovery."
```
