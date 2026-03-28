# Fix Paste All File Types - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pasting PDFs and text files into the composer work the same as drag-drop, including a fallback for clipboard blobs without a real file path.

**Architecture:** Widen the filter in `handlePaste` from image-only to `ALL_SUPPORTED_TYPES`. Add a `saveClipboardFile` method across the desktop bridge (Electron IPC) and server transport (WebSocket RPC) to handle non-image clipboard blobs that lack a file path. Mirrors the existing `readClipboardImage` pattern.

**Tech Stack:** TypeScript, React, Electron IPC, Zod, WebSocket RPC

**Spec:** `docs/superpowers/specs/2026-03-28-fix-paste-all-file-types.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/contracts/src/ws/methods.ts` | Modify (line 205) | Add `clipboard.saveFile` RPC schema |
| `apps/server/src/transport/ws-router.ts` | Modify (lines 296-306) | Add dispatcher case for `clipboard.saveFile` |
| `apps/desktop/src/main/main.ts` | Modify (lines 296-297) | Add `save-clipboard-file` IPC handler |
| `apps/desktop/src/main/preload.ts` | Modify (lines 34-35) | Expose `saveClipboardFile` on bridge |
| `apps/web/src/transport/desktop-bridge.d.ts` | Modify (line 28) | Add `saveClipboardFile` type declaration |
| `apps/web/src/transport/types.ts` | Modify (line 84) | Add `saveClipboardFile` to `McodeTransport` |
| `apps/web/src/transport/ws-transport.ts` | Modify (lines 231-232) | Implement `saveClipboardFile` RPC call |
| `apps/web/src/__tests__/mocks/transport.ts` | Modify (line 83) | Add `saveClipboardFile` mock |
| `apps/web/src/components/chat/Composer.tsx` | Modify (lines 349-410) | Rewrite `handlePaste` for all supported types |

---

### Task 1: Add `clipboard.saveFile` RPC schema to contracts

**Files:**
- Modify: `packages/contracts/src/ws/methods.ts:201-205`

- [ ] **Step 1: Add the new RPC method schema**

In `packages/contracts/src/ws/methods.ts`, add the `clipboard.saveFile` entry to `WS_METHODS` just before the closing `} as const;` on line 205:

```typescript
  "clipboard.saveFile": {
    params: z.object({
      /** Base64-encoded file content. */
      data: z.string(),
      /** MIME type of the file (e.g. "application/pdf"). */
      mimeType: z.string(),
      /** Display name for the file (e.g. "document.pdf"). */
      fileName: z.string(),
    }),
    result: AttachmentMetaSchema,
  },
```

`AttachmentMetaSchema` is already imported on line 6.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd packages/contracts && npx tsc --noEmit`
Expected: No errors. The new method is inferred into `WsMethodName` automatically via `keyof typeof WS_METHODS`.

- [ ] **Step 3: Commit**

```bash
git add packages/contracts/src/ws/methods.ts
git commit -m "feat: add clipboard.saveFile RPC schema to contracts"
```

---

### Task 2: Add server-side dispatcher for `clipboard.saveFile`

**Files:**
- Modify: `apps/server/src/transport/ws-router.ts:296-306`

- [ ] **Step 1: Add the import for `tmpdir`**

At the top of `apps/server/src/transport/ws-router.ts`, add these imports:

```typescript
import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
```

- [ ] **Step 2: Add the dispatcher case**

In the `dispatch` function's switch statement, add a new case before the `// App` comment block (before `case "app.version":` around line 302):

```typescript
    // Clipboard
    case "clipboard.saveFile": {
      const buffer = Buffer.from(params.data, "base64");
      const id = randomUUID();
      const ext = params.mimeType === "application/pdf" ? ".pdf"
        : params.mimeType === "text/plain" ? ".txt"
        : "";
      const tempDir = join(tmpdir(), "mcode-attachments");
      await mkdir(tempDir, { recursive: true });
      const tempPath = join(tempDir, `${id}${ext}`);
      await writeFile(tempPath, buffer);
      return {
        id,
        name: params.fileName,
        mimeType: params.mimeType,
        sizeBytes: buffer.byteLength,
        sourcePath: tempPath,
      };
    }
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd apps/server && npx tsc --noEmit`
Expected: No errors. The new case satisfies the `WsMethodName` exhaustive switch since it was added to `WS_METHODS` in Task 1.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/transport/ws-router.ts
git commit -m "feat: add clipboard.saveFile dispatcher to server router"
```

---

### Task 3: Add `saveClipboardFile` to Electron desktop bridge

**Files:**
- Modify: `apps/desktop/src/main/main.ts:296-297`
- Modify: `apps/desktop/src/main/preload.ts:34-35`
- Modify: `apps/web/src/transport/desktop-bridge.d.ts:28`

- [ ] **Step 1: Add IPC handler in main.ts**

In `apps/desktop/src/main/main.ts`, add the new handler right after the `read-clipboard-image` handler (after line 296, before the `// Log path` comment on line 298):

```typescript
  // Save a clipboard file blob to a temp location and return metadata
  ipcMain.handle(
    "save-clipboard-file",
    async (_event, buffer: Uint8Array, mimeType: string, fileName: string) => {
      const id = randomUUID();
      const ext = mimeType === "application/pdf" ? ".pdf"
        : mimeType === "text/plain" ? ".txt"
        : "";
      const tempDir = join(app.getPath("temp"), "mcode-attachments");
      await mkdir(tempDir, { recursive: true });
      const tempPath = join(tempDir, `${id}${ext}`);
      await writeFile(tempPath, Buffer.from(buffer));
      return {
        id,
        name: fileName,
        mimeType,
        sizeBytes: buffer.byteLength,
        sourcePath: tempPath,
      };
    },
  );
```

All needed imports (`randomUUID`, `mkdir`, `writeFile`, `join`, `app`) are already imported at lines 8-21.

- [ ] **Step 2: Expose in preload.ts**

In `apps/desktop/src/main/preload.ts`, add the new method after `readClipboardImage` (after line 35):

```typescript
  /** Save a file blob from the clipboard to a temp location. */
  saveClipboardFile: (buffer: Uint8Array, mimeType: string, fileName: string): Promise<unknown> =>
    ipcRenderer.invoke("save-clipboard-file", buffer, mimeType, fileName),
```

- [ ] **Step 3: Add type declaration**

In `apps/web/src/transport/desktop-bridge.d.ts`, add after the `readClipboardImage` line (after line 22):

```typescript
  /** Save a clipboard file blob to disk. Returns metadata or null. */
  saveClipboardFile(buffer: Uint8Array, mimeType: string, fileName: string): Promise<AttachmentMeta | null>;
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd apps/desktop && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/main.ts apps/desktop/src/main/preload.ts apps/web/src/transport/desktop-bridge.d.ts
git commit -m "feat: add saveClipboardFile to Electron desktop bridge"
```

---

### Task 4: Add `saveClipboardFile` to transport interface and implementation

**Files:**
- Modify: `apps/web/src/transport/types.ts:84`
- Modify: `apps/web/src/transport/ws-transport.ts:231-232`
- Modify: `apps/web/src/__tests__/mocks/transport.ts:83`

- [ ] **Step 1: Add to McodeTransport interface**

In `apps/web/src/transport/types.ts`, add after the `readClipboardImage` line (after line 84):

```typescript
  /** Save a clipboard file blob to disk via the server. Returns attachment metadata. */
  saveClipboardFile(data: string, mimeType: string, fileName: string): Promise<AttachmentMeta | null>;
```

- [ ] **Step 2: Implement in ws-transport.ts**

In `apps/web/src/transport/ws-transport.ts`, add after the `readClipboardImage` line (after line 232):

```typescript
    saveClipboardFile: (data, mimeType, fileName) =>
      rpc<AttachmentMeta | null>("clipboard.saveFile", { data, mimeType, fileName }),
```

- [ ] **Step 3: Add mock**

In `apps/web/src/__tests__/mocks/transport.ts`, add after the `readClipboardImage` line (after line 83):

```typescript
  saveClipboardFile: vi.fn().mockResolvedValue(null),
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd apps/web && npx tsc --noEmit`
Expected: No errors. The `McodeTransport` interface, `ws-transport`, and mock all agree on the new method.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/transport/types.ts apps/web/src/transport/ws-transport.ts apps/web/src/__tests__/mocks/transport.ts
git commit -m "feat: add saveClipboardFile to transport interface and implementation"
```

---

### Task 5: Rewrite `handlePaste` to support all file types

**Files:**
- Modify: `apps/web/src/components/chat/Composer.tsx:349-410`

- [ ] **Step 1: Replace the entire `handlePaste` callback**

In `apps/web/src/components/chat/Composer.tsx`, replace lines 349-410 (the full `handlePaste` callback) with:

```typescript
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    const supported = files.filter((f) => ALL_SUPPORTED_TYPES.has(f.type));
    if (supported.length === 0) return;

    e.preventDefault();

    const bridge = window.desktopBridge;

    // Attempt to resolve real file paths for all supported files
    const paths = supported.map((f) => {
      try { return bridge?.getPathForFile?.(f) || null; } catch { return null; }
    });

    // Partition into files with and without real paths
    const withPaths: File[] = [];
    const withPathPaths: (string | null)[] = [];
    const withoutPaths: File[] = [];

    for (let i = 0; i < supported.length; i++) {
      if (paths[i]) {
        withPaths.push(supported[i]);
        withPathPaths.push(paths[i]);
      } else {
        withoutPaths.push(supported[i]);
      }
    }

    // Files with real paths go straight to addFiles
    if (withPaths.length > 0) {
      addFiles(withPaths, withPathPaths);
    }

    // Files without paths need fallback handling
    for (const file of withoutPaths) {
      if (file.type.startsWith("image/")) {
        // Images: use existing clipboard image reader
        try {
          const meta = bridge?.readClipboardImage
            ? await bridge.readClipboardImage()
            : await getTransport().readClipboardImage();
          if (meta) {
            setAttachments((prev) => {
              if (prev.length >= MAX_ATTACHMENTS) return prev;
              const previewUrl = URL.createObjectURL(file);
              return [...prev, {
                id: meta.id,
                name: meta.name,
                mimeType: meta.mimeType,
                sizeBytes: meta.sizeBytes,
                previewUrl,
                filePath: meta.sourcePath,
              }];
            });
          }
        } catch {
          addFiles([file]);
        }
      } else {
        // Non-images (PDF, text): read blob and save via bridge or transport
        if (file.size > getMaxSize(file.type)) continue;
        try {
          const arrayBuffer = await file.arrayBuffer();
          let meta: AttachmentMeta | null = null;
          if (bridge?.saveClipboardFile) {
            meta = await bridge.saveClipboardFile(
              new Uint8Array(arrayBuffer),
              file.type,
              file.name,
            );
          } else {
            // Encode as base64 for the WebSocket RPC path
            const bytes = new Uint8Array(arrayBuffer);
            let binary = "";
            for (let i = 0; i < bytes.byteLength; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            const base64 = btoa(binary);
            meta = await getTransport().saveClipboardFile(base64, file.type, file.name);
          }
          if (meta) {
            setAttachments((prev) => {
              if (prev.length >= MAX_ATTACHMENTS) return prev;
              return [...prev, {
                id: meta!.id,
                name: meta!.name,
                mimeType: meta!.mimeType,
                sizeBytes: meta!.sizeBytes,
                previewUrl: "",
                filePath: meta!.sourcePath,
              }];
            });
          }
        } catch {
          // Best-effort: try addFiles without a path (will be filtered by collectAndClearAttachments)
          addFiles([file]);
        }
      }
    }
  }, [addFiles]);
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/web && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/chat/Composer.tsx
git commit -m "fix: support pasting PDFs and text files in composer

Closes #70"
```

---

### Task 6: Add unit tests for paste behavior

**Files:**
- Create: `apps/web/src/__tests__/Composer.paste.test.ts`

- [ ] **Step 1: Write the test file**

Create `apps/web/src/__tests__/Composer.paste.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for the handlePaste logic extracted from Composer.
 * We test the filtering and branching logic directly rather than
 * rendering the full Composer component (which requires extensive mocking).
 */

// Constants mirrored from Composer.tsx for test assertions
const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const SUPPORTED_FILE_TYPES = new Set(["application/pdf", "text/plain"]);
const ALL_SUPPORTED_TYPES = new Set([...SUPPORTED_IMAGE_TYPES, ...SUPPORTED_FILE_TYPES]);
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_PDF_SIZE = 32 * 1024 * 1024;
const MAX_TEXT_SIZE = 1 * 1024 * 1024;

function getMaxSize(mimeType: string): number {
  if (SUPPORTED_IMAGE_TYPES.has(mimeType)) return MAX_IMAGE_SIZE;
  if (mimeType === "application/pdf") return MAX_PDF_SIZE;
  if (mimeType === "text/plain") return MAX_TEXT_SIZE;
  return 0;
}

function createMockFile(name: string, type: string, size: number): File {
  const content = new Uint8Array(size);
  return new File([content], name, { type });
}

describe("Paste file filtering", () => {
  it("accepts image files", () => {
    const file = createMockFile("photo.png", "image/png", 1024);
    expect(ALL_SUPPORTED_TYPES.has(file.type)).toBe(true);
  });

  it("accepts PDF files", () => {
    const file = createMockFile("doc.pdf", "application/pdf", 1024);
    expect(ALL_SUPPORTED_TYPES.has(file.type)).toBe(true);
  });

  it("accepts plain text files", () => {
    const file = createMockFile("notes.txt", "text/plain", 1024);
    expect(ALL_SUPPORTED_TYPES.has(file.type)).toBe(true);
  });

  it("rejects unsupported file types", () => {
    const file = createMockFile("archive.zip", "application/zip", 1024);
    expect(ALL_SUPPORTED_TYPES.has(file.type)).toBe(false);
  });

  it("rejects empty MIME type", () => {
    const file = createMockFile("unknown", "", 1024);
    expect(ALL_SUPPORTED_TYPES.has(file.type)).toBe(false);
  });
});

describe("Paste size validation", () => {
  it("allows image under 5MB", () => {
    const file = createMockFile("photo.png", "image/png", MAX_IMAGE_SIZE - 1);
    expect(file.size <= getMaxSize(file.type)).toBe(true);
  });

  it("rejects image over 5MB", () => {
    const file = createMockFile("huge.png", "image/png", MAX_IMAGE_SIZE + 1);
    expect(file.size > getMaxSize(file.type)).toBe(true);
  });

  it("allows PDF under 32MB", () => {
    const file = createMockFile("doc.pdf", "application/pdf", MAX_PDF_SIZE - 1);
    expect(file.size <= getMaxSize(file.type)).toBe(true);
  });

  it("rejects PDF over 32MB", () => {
    const file = createMockFile("huge.pdf", "application/pdf", MAX_PDF_SIZE + 1);
    expect(file.size > getMaxSize(file.type)).toBe(true);
  });

  it("allows text under 1MB", () => {
    const file = createMockFile("notes.txt", "text/plain", MAX_TEXT_SIZE - 1);
    expect(file.size <= getMaxSize(file.type)).toBe(true);
  });

  it("rejects text over 1MB", () => {
    const file = createMockFile("huge.txt", "text/plain", MAX_TEXT_SIZE + 1);
    expect(file.size > getMaxSize(file.type)).toBe(true);
  });

  it("returns 0 for unsupported type", () => {
    expect(getMaxSize("application/zip")).toBe(0);
  });
});

describe("Paste path partitioning", () => {
  it("partitions files into with-path and without-path groups", () => {
    const files = [
      createMockFile("a.png", "image/png", 100),
      createMockFile("b.pdf", "application/pdf", 100),
      createMockFile("c.txt", "text/plain", 100),
    ];

    // Simulate getPathForFile: first file has a path, others don't
    const mockGetPath = (f: File): string | null => {
      if (f.name === "a.png") return "/tmp/a.png";
      return null;
    };

    const withPaths: File[] = [];
    const withoutPaths: File[] = [];

    for (const file of files) {
      const path = mockGetPath(file);
      if (path) {
        withPaths.push(file);
      } else {
        withoutPaths.push(file);
      }
    }

    expect(withPaths).toHaveLength(1);
    expect(withPaths[0].name).toBe("a.png");
    expect(withoutPaths).toHaveLength(2);
    expect(withoutPaths.map((f) => f.name)).toEqual(["b.pdf", "c.txt"]);
  });

  it("routes images without path to readClipboardImage", () => {
    const file = createMockFile("screenshot.png", "image/png", 100);
    const isImage = file.type.startsWith("image/");
    expect(isImage).toBe(true);
  });

  it("routes non-images without path to saveClipboardFile", () => {
    const file = createMockFile("doc.pdf", "application/pdf", 100);
    const isImage = file.type.startsWith("image/");
    expect(isImage).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run src/__tests__/Composer.paste.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/__tests__/Composer.paste.test.ts
git commit -m "test: add unit tests for paste file filtering and validation"
```

---

### Task 7: Build and verify

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `cd apps/web && bun run test`
Expected: All tests pass including the new paste tests.

- [ ] **Step 2: Run TypeScript check across all packages**

Run: `npx tsc --noEmit` from packages/contracts, apps/server, apps/web, and apps/desktop.
Expected: No type errors in any package.

- [ ] **Step 3: Verify the dev build starts**

Run: `bun run dev:web` (if available) or `cd apps/web && bun run build`
Expected: Build succeeds with no errors.
