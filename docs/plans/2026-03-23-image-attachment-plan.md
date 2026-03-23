# Image & File Attachment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users attach images and files to chat messages via clipboard paste or drag-and-drop, and send them to Claude through the Agent SDK's multimodal content blocks.

**Architecture:** File-path-first approach. The renderer sends only file path strings over IPC (<100 bytes each). The main process reads files from disk, converts to base64, and builds `SDKUserMessage` content blocks for the SDK's `AsyncIterable` prompt interface.

**Tech Stack:** Electron 35 (webUtils, clipboard, protocol), React 19, Zustand, better-sqlite3, Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` v0.2.81)

**Design doc:** `docs/plans/2026-03-23-image-attachment-design.md`

---

## Task 1: Shared Types (AttachmentMeta)

Define the `AttachmentMeta` type used across backend and frontend.

**Files:**
- Modify: `apps/desktop/src/main/models.ts:46-57`
- Modify: `apps/web/src/transport/types.ts:38-49`

**Step 1: Add AttachmentMeta to backend models**

In `apps/desktop/src/main/models.ts`, add after line 57:

```typescript
/** Metadata for an image or file attachment. No binary data, just a pointer. */
export interface AttachmentMeta {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sourcePath: string;
}

/** Stored attachment metadata (no sourcePath, since files live at a known location). */
export interface StoredAttachment {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}
```

**Step 2: Add AttachmentMeta to frontend transport types**

In `apps/web/src/transport/types.ts`, add after the `Message` interface (line 49):

```typescript
export interface AttachmentMeta {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sourcePath: string;
}

export interface StoredAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}
```

**Step 3: Update Message interfaces to include attachments**

In `apps/desktop/src/main/models.ts`, add to the `Message` interface after `sequence`:

```typescript
  readonly attachments: StoredAttachment[] | null;
```

In `apps/web/src/transport/types.ts`, add to the `Message` interface after `sequence`:

```typescript
  attachments: StoredAttachment[] | null;
```

**Step 4: Update transport method signatures**

In `apps/web/src/transport/types.ts`, update `McodeTransport`:

```typescript
  // Change sendMessage to accept optional attachments
  sendMessage(threadId: string, content: string, model?: string, permissionMode?: PermissionMode, attachments?: AttachmentMeta[]): Promise<void>;

  // Change createAndSendMessage to accept optional attachments
  createAndSendMessage(
    workspaceId: string,
    content: string,
    model: string,
    permissionMode?: PermissionMode,
    mode?: "direct" | "worktree",
    branch?: string,
    attachments?: AttachmentMeta[],
  ): Promise<Thread>;

  // New: read clipboard image via main process
  readClipboardImage(): Promise<AttachmentMeta | null>;
```

**Step 5: Commit**

```bash
git add apps/desktop/src/main/models.ts apps/web/src/transport/types.ts
git commit -m "feat: add AttachmentMeta types for image/file attachments"
```

---

## Task 2: Database Migration

Add the `attachments` column to the `messages` table and update the message repository.

**Files:**
- Modify: `apps/desktop/src/main/store/database.ts:74-94`
- Modify: `apps/desktop/src/main/repositories/message-repo.ts`

**Step 1: Add migration V3 in database.ts**

In `apps/desktop/src/main/store/database.ts`, add after the V2 migration block (after line 93):

```typescript
  if (currentVersion < 3) {
    db.exec("ALTER TABLE messages ADD COLUMN attachments TEXT DEFAULT NULL");
    db.prepare("INSERT INTO _migrations (version) VALUES (?)").run(3);
  }
```

**Step 2: Update MessageRow interface in message-repo.ts**

In `apps/desktop/src/main/repositories/message-repo.ts`, add to the `MessageRow` interface (line 5-16):

```typescript
  attachments: string | null;
```

**Step 3: Update rowToMessage to parse attachments**

In `apps/desktop/src/main/repositories/message-repo.ts`, update `rowToMessage` (line 29-42) to include:

```typescript
    attachments: parseJsonField(row.attachments) as StoredAttachment[] | null,
```

Add the import at the top:

```typescript
import type { Message, MessageRole, StoredAttachment } from "../models.js";
```

**Step 4: Update MESSAGE_COLUMNS constant**

In `apps/desktop/src/main/repositories/message-repo.ts`, update line 44:

```typescript
const MESSAGE_COLUMNS =
  "id, thread_id, role, content, tool_calls, files_changed, cost_usd, tokens_used, timestamp, sequence, attachments";
```

**Step 5: Add attachments parameter to create function**

In `apps/desktop/src/main/repositories/message-repo.ts`, update the `create` function:

```typescript
export function create(
  db: Database.Database,
  threadId: string,
  role: MessageRole,
  content: string,
  sequence: number,
  attachments?: StoredAttachment[],
): Message {
  const id = randomUUID();
  const now = new Date().toISOString();
  const attachmentsJson = attachments && attachments.length > 0
    ? JSON.stringify(attachments)
    : null;

  db.prepare(
    "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence, attachments) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, threadId, role, content, now, sequence, attachmentsJson);

  return {
    id,
    thread_id: threadId,
    role,
    content,
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: null,
    timestamp: now,
    sequence,
    attachments: attachments ?? null,
  };
}
```

**Step 6: Commit**

```bash
git add apps/desktop/src/main/store/database.ts apps/desktop/src/main/repositories/message-repo.ts
git commit -m "feat: add attachments column to messages table"
```

---

## Task 3: Preload & IPC Handlers

Expose `getPathForFile` in preload and add clipboard/attachment IPC handlers.

**Files:**
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/main/index.ts:139-263`

**Step 1: Update preload to expose getPathForFile**

In `apps/desktop/src/preload/index.ts`, replace the entire file:

```typescript
import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  invoke: (channel: string, ...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args),

  on: (channel: string, callback: (...args: unknown[]) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      ...args: unknown[]
    ) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },

  getPathForFile: (file: File) => webUtils.getPathForFile(file),
});
```

**Step 2: Update the global type declaration**

Check if there's a global `.d.ts` for `window.electronAPI`. Search for it:

```bash
grep -r "electronAPI" apps/web/src --include="*.d.ts"
```

If found, add `getPathForFile: (file: File) => string` to the interface. If not found, create `apps/web/src/electron.d.ts`:

```typescript
interface ElectronAPI {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, callback: (...args: unknown[]) => void) => () => void;
  getPathForFile: (file: File) => string;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
```

**Step 3: Update send-message IPC handler**

In `apps/desktop/src/main/index.ts`, replace the `send-message` handler (lines 198-203):

```typescript
  ipcMain.handle(
    "send-message",
    async (_event, threadId: string, content: string, model?: string, permissionMode?: string, attachments?: unknown[]) => {
      const validatedAttachments = validateAttachments(attachments);
      await state.sendMessage(threadId, content, sanitizePermissionMode(permissionMode), model, validatedAttachments);
    },
  );
```

**Step 4: Update create-and-send-message IPC handler**

In `apps/desktop/src/main/index.ts`, replace the `create-and-send-message` handler (lines 206-216):

```typescript
  ipcMain.handle(
    "create-and-send-message",
    async (_event, workspaceId: string, content: string, model: string, permissionMode?: string, mode?: string, branch?: string, attachments?: unknown[]) => {
      const validatedAttachments = validateAttachments(attachments);
      return state.createAndSendMessage(
        workspaceId, content, model,
        sanitizePermissionMode(permissionMode),
        (mode as "direct" | "worktree") ?? "direct",
        branch ?? "main",
        validatedAttachments,
      );
    },
  );
```

**Step 5: Add read-clipboard-image IPC handler**

In `apps/desktop/src/main/index.ts`, add a new handler inside `registerIpcHandlers` (after the `send-message` handler):

```typescript
  ipcMain.handle("read-clipboard-image", async () => {
    return state.readClipboardImage();
  });
```

**Step 6: Add validateAttachments helper**

In `apps/desktop/src/main/index.ts`, add after `sanitizePermissionMode` (after line 34):

```typescript
import type { AttachmentMeta } from "./models.js";

const VALID_ATTACHMENT_ID = /^[a-f0-9-]+$/;
const VALID_MIME_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "application/pdf", "text/plain",
]);
const MAX_ATTACHMENTS = 5;

function validateAttachments(raw?: unknown[]): AttachmentMeta[] {
  if (!raw || !Array.isArray(raw) || raw.length === 0) return [];
  if (raw.length > MAX_ATTACHMENTS) {
    throw new Error(`Too many attachments (max ${MAX_ATTACHMENTS})`);
  }

  return raw.map((item) => {
    const att = item as Record<string, unknown>;
    const id = String(att.id ?? "");
    const name = String(att.name ?? "");
    const mimeType = String(att.mimeType ?? "");
    const sizeBytes = Number(att.sizeBytes ?? 0);
    const sourcePath = String(att.sourcePath ?? "");

    if (!VALID_ATTACHMENT_ID.test(id)) {
      throw new Error(`Invalid attachment ID: ${id}`);
    }
    if (!VALID_MIME_TYPES.has(mimeType)) {
      throw new Error(`Unsupported MIME type: ${mimeType}`);
    }
    if (!sourcePath || !isAbsolute(sourcePath)) {
      throw new Error(`Invalid attachment path: ${sourcePath}`);
    }

    return { id, name, mimeType, sizeBytes, sourcePath };
  });
}
```

**Step 7: Commit**

```bash
git add apps/desktop/src/preload/index.ts apps/desktop/src/main/index.ts apps/web/src/electron.d.ts
git commit -m "feat: add attachment IPC handlers and preload getPathForFile"
```

---

## Task 4: AppState Attachment Handling

Update AppState to handle attachments in the send flow and clipboard reading.

**Files:**
- Modify: `apps/desktop/src/main/app-state.ts`

**Step 1: Add imports**

In `apps/desktop/src/main/app-state.ts`, update the imports at the top:

```typescript
import { existsSync, statSync, mkdirSync, copyFileSync } from "fs";
import { isAbsolute, join, extname } from "path";
import { clipboard, nativeImage, app } from "electron";
import { writeFileSync } from "fs";
import { randomUUID } from "crypto";
```

And update the models import:

```typescript
import type { Workspace, Thread, Message, AttachmentMeta, StoredAttachment } from "./models.js";
```

**Step 2: Update sendMessage signature and body**

In `apps/desktop/src/main/app-state.ts`, update `sendMessage` (lines 235-315):

```typescript
  async sendMessage(
    threadId: string,
    content: string,
    permissionMode: string,
    model = "claude-sonnet-4-6",
    attachments: AttachmentMeta[] = [],
  ): Promise<void> {
```

After the user message persist step (around line 270), replace the `MessageRepo.create` call:

```typescript
    // Persist attachments to permanent storage
    const storedAttachments = this.persistAttachments(threadId, attachments);

    MessageRepo.create(this.db, threadId, "user", content, nextSeq, storedAttachments.length > 0 ? storedAttachments : undefined);
```

Update the sidecar call (around line 297):

```typescript
      this.sidecar.sendMessage(
        sessionName,
        content,
        cwd,
        resolvedModel,
        isResume,
        permissionMode,
        storedAttachments.length > 0 ? attachments : undefined,
      );
```

**Step 3: Add persistAttachments helper method**

Add to the `AppState` class:

```typescript
  /**
   * Copy attachment files to persistent storage and return stored metadata.
   * Location: {userData}/attachments/{threadId}/{id}.{ext}
   */
  private persistAttachments(threadId: string, attachments: AttachmentMeta[]): StoredAttachment[] {
    if (attachments.length === 0) return [];

    const baseDir = join(app.getPath("userData"), "attachments", threadId);
    mkdirSync(baseDir, { recursive: true });

    return attachments.map((att) => {
      const ext = extname(att.name) || mimeToExt(att.mimeType);
      const destPath = join(baseDir, `${att.id}${ext}`);

      if (!existsSync(att.sourcePath)) {
        throw new Error(`Attachment file not found: ${att.sourcePath}`);
      }

      copyFileSync(att.sourcePath, destPath);

      return {
        id: att.id,
        name: att.name,
        mimeType: att.mimeType,
        sizeBytes: att.sizeBytes,
      };
    });
  }
```

**Step 4: Add readClipboardImage method**

Add to the `AppState` class:

```typescript
  /**
   * Read an image from the system clipboard, write it to a temp file,
   * and return attachment metadata. Returns null if clipboard has no image.
   */
  readClipboardImage(): AttachmentMeta | null {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;

    const buffer = img.toJPEG(85);
    const id = randomUUID();
    const name = `clipboard-${Date.now()}.jpg`;
    const tempDir = join(app.getPath("temp"), "mcode-attachments");
    mkdirSync(tempDir, { recursive: true });
    const tempPath = join(tempDir, `${id}.jpg`);
    writeFileSync(tempPath, buffer);

    return {
      id,
      name,
      mimeType: "image/jpeg",
      sizeBytes: buffer.byteLength,
      sourcePath: tempPath,
    };
  }
```

**Step 5: Add mimeToExt helper**

Add at the bottom of `app-state.ts` (outside the class):

```typescript
function mimeToExt(mimeType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
  };
  return map[mimeType] ?? "";
}
```

**Step 6: Update createAndSendMessage to pass attachments**

Update the `createAndSendMessage` signature and body:

```typescript
  async createAndSendMessage(
    workspaceId: string,
    content: string,
    model = "claude-sonnet-4-6",
    permissionMode = "default",
    mode: "direct" | "worktree" = "direct",
    branch = "main",
    attachments: AttachmentMeta[] = [],
  ): Promise<Thread> {
    const title = truncateTitle(content);

    const thread = mode === "worktree"
      ? this.createThread(workspaceId, title, "worktree", branch)
      : ThreadRepo.create(this.db, workspaceId, title, "direct", branch);

    await this.sendMessage(thread.id, content, permissionMode, model, attachments);

    const updated = ThreadRepo.findById(this.db, thread.id);
    return updated ?? thread;
  }
```

**Step 7: Update deleteThread to clean up attachments**

In the `deleteThread` method, add attachment cleanup before the soft delete (before the `return` on line 217):

```typescript
    // Clean up attachment files
    const attachmentsDir = join(app.getPath("userData"), "attachments", threadId);
    if (existsSync(attachmentsDir)) {
      try {
        rmSync(attachmentsDir, { recursive: true, force: true });
      } catch {
        // Non-fatal: files may already be gone
      }
    }
```

Add `rmSync` to the `fs` import.

**Step 8: Commit**

```bash
git add apps/desktop/src/main/app-state.ts
git commit -m "feat: handle attachment persistence and clipboard reading in AppState"
```

---

## Task 5: SidecarClient Multimodal Support

Switch from string prompt to `AsyncIterable<SDKUserMessage>` when attachments are present.

**Files:**
- Modify: `apps/desktop/src/main/sidecar/client.ts`

**Step 1: Add imports**

At the top of `apps/desktop/src/main/sidecar/client.ts`, add:

```typescript
import { readFile } from "fs/promises";
import type { AttachmentMeta } from "../models.js";
```

**Step 2: Update sendMessage signature**

Update the `sendMessage` method signature (line 55-62) to accept optional attachments:

```typescript
  async sendMessage(
    sessionId: string,
    message: string,
    cwd: string,
    model: string,
    resume: boolean,
    permissionMode: string,
    attachments?: AttachmentMeta[],
  ): Promise<void> {
```

**Step 3: Change prompt construction**

Replace line 100 (`const q = query({ prompt: message, options });`) with:

```typescript
      const hasAttachments = attachments && attachments.length > 0;
      const prompt = hasAttachments
        ? this.buildMultimodalPrompt(message, attachments, sessionId)
        : message;
      const q = query({ prompt, options });
```

**Step 4: Add buildMultimodalPrompt method**

Add to the `SidecarClient` class:

```typescript
  /**
   * Build an AsyncIterable that yields a single SDKUserMessage with
   * multimodal content blocks (images, documents, text).
   */
  private async *buildMultimodalPrompt(
    message: string,
    attachments: AttachmentMeta[],
    sessionId: string,
  ): AsyncGenerator<{ type: "user"; session_id: string; parent_tool_use_id: null; message: { role: "user"; content: Array<Record<string, unknown>> } }> {
    const contentBlocks: Array<Record<string, unknown>> = [];

    for (const att of attachments) {
      try {
        const data = await readFile(att.sourcePath);

        if (att.mimeType.startsWith("image/")) {
          contentBlocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: att.mimeType,
              data: data.toString("base64"),
            },
          });
        } else if (att.mimeType === "application/pdf") {
          contentBlocks.push({
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: data.toString("base64"),
            },
          });
        } else if (att.mimeType === "text/plain") {
          contentBlocks.push({
            type: "document",
            source: {
              type: "text",
              media_type: "text/plain",
              data: data.toString("utf-8"),
            },
          });
        }
      } catch (err) {
        logger.error("Failed to read attachment", {
          id: att.id,
          path: att.sourcePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    contentBlocks.push({ type: "text", text: message });

    yield {
      type: "user" as const,
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        role: "user" as const,
        content: contentBlocks,
      },
    };
  }
```

**Step 5: Commit**

```bash
git add apps/desktop/src/main/sidecar/client.ts
git commit -m "feat: support multimodal content blocks in SidecarClient"
```

---

## Task 6: Frontend Transport Layer

Update the Electron transport to pass attachments through IPC.

**Files:**
- Modify: `apps/web/src/transport/electron.ts`

**Step 1: Update sendMessage**

In `apps/web/src/transport/electron.ts`, update the `sendMessage` method (line 59-61):

```typescript
    async sendMessage(threadId, content, model, permissionMode, attachments) {
      await api.invoke("send-message", threadId, content, model, permissionMode, attachments);
    },
```

**Step 2: Update createAndSendMessage**

Update the `createAndSendMessage` method (line 63-64):

```typescript
    async createAndSendMessage(workspaceId, content, model, permissionMode, mode, branch, attachments) {
      return api.invoke("create-and-send-message", workspaceId, content, model, permissionMode, mode, branch, attachments) as Promise<Thread>;
    },
```

**Step 3: Add readClipboardImage**

Add a new method:

```typescript
    async readClipboardImage() {
      return api.invoke("read-clipboard-image") as Promise<AttachmentMeta | null>;
    },
```

Add the import:

```typescript
import type { McodeTransport, Workspace, Thread, Message, GitBranch, AttachmentMeta } from "./types";
```

**Step 4: Commit**

```bash
git add apps/web/src/transport/electron.ts
git commit -m "feat: pass attachments through Electron transport layer"
```

---

## Task 7: Zustand Stores (threadStore + workspaceStore)

Update stores to handle attachments in send flows.

**Files:**
- Modify: `apps/web/src/stores/threadStore.ts`
- Modify: `apps/web/src/stores/workspaceStore.ts`

**Step 1: Update threadStore.sendMessage**

In `apps/web/src/stores/threadStore.ts`, update the `sendMessage` signature in the interface (line 24):

```typescript
  sendMessage: (threadId: string, content: string, model?: string, permissionMode?: PermissionMode, attachments?: AttachmentMeta[]) => Promise<void>;
```

Update the implementation (line 67-100) to accept and pass attachments:

```typescript
  sendMessage: async (threadId, content, model, permissionMode, attachments) => {
    const userMessage: Message = {
      id: crypto.randomUUID(),
      thread_id: threadId,
      role: "user",
      content,
      tool_calls: null,
      files_changed: null,
      cost_usd: null,
      tokens_used: null,
      timestamp: new Date().toISOString(),
      sequence: get().messages.length + 1,
      attachments: attachments?.map((a) => ({
        id: a.id,
        name: a.name,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
      })) ?? null,
    };

    set((state) => ({
      messages: [...state.messages, userMessage],
      runningThreadIds: new Set([...state.runningThreadIds, threadId]),
      agentStartTimes: { ...state.agentStartTimes, [threadId]: Date.now() },
      error: null,
    }));

    try {
      await getTransport().sendMessage(threadId, content, model, permissionMode, attachments);
    } catch (e) {
      set((state) => {
        const next = new Set(state.runningThreadIds);
        next.delete(threadId);
        const nextStartTimes = { ...state.agentStartTimes };
        delete nextStartTimes[threadId];
        return { error: String(e), runningThreadIds: next, agentStartTimes: nextStartTimes };
      });
    }
  },
```

Add the import:

```typescript
import type { Message, ToolCall, PermissionMode, InteractionMode, AttachmentMeta } from "@/transport";
```

**Step 2: Update workspaceStore.createAndSendMessage**

In `apps/web/src/stores/workspaceStore.ts`, update the signature:

```typescript
  createAndSendMessage: (content: string, model: string, permissionMode?: PermissionMode, attachments?: AttachmentMeta[]) => Promise<Thread>;
```

Update the implementation to accept and pass attachments:

```typescript
  createAndSendMessage: async (content, model, permissionMode, attachments) => {
    const workspaceId = get().activeWorkspaceId;
    if (!workspaceId) throw new Error("No workspace selected");

    const { newThreadMode, newThreadBranch } = get();
    const branch = newThreadBranch || "main";

    set({ error: null });
    try {
      const thread = await getTransport().createAndSendMessage(
        workspaceId, content, model, permissionMode, newThreadMode, branch, attachments,
      );
```

**Step 3: Commit**

```bash
git add apps/web/src/stores/threadStore.ts apps/web/src/stores/workspaceStore.ts
git commit -m "feat: thread attachments through Zustand stores"
```

---

## Task 8: AttachmentPreview Component

Build the thumbnail strip that displays pending attachments in the Composer.

**Files:**
- Create: `apps/web/src/components/chat/AttachmentPreview.tsx`

**Step 1: Create the component**

```typescript
import { X, FileText, File } from "lucide-react";

export interface PendingAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl: string;
  filePath: string | null;
}

interface AttachmentPreviewProps {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
}

export function AttachmentPreview({ attachments, onRemove }: AttachmentPreviewProps) {
  if (attachments.length === 0) return null;

  return (
    <div className="flex gap-2 overflow-x-auto px-4 py-2">
      {attachments.map((att) => (
        <div
          key={att.id}
          className="group relative flex-shrink-0 rounded-lg border border-border bg-background overflow-hidden"
        >
          {att.mimeType.startsWith("image/") ? (
            <img
              src={att.previewUrl}
              alt={att.name}
              className="h-16 w-16 object-cover"
            />
          ) : (
            <div className="flex h-16 w-24 items-center gap-1.5 px-2">
              {att.mimeType === "application/pdf" ? (
                <FileText size={16} className="shrink-0 text-red-400" />
              ) : (
                <File size={16} className="shrink-0 text-muted-foreground" />
              )}
              <span className="truncate text-[11px] text-muted-foreground">
                {att.name}
              </span>
            </div>
          )}
          <button
            onClick={() => onRemove(att.id)}
            className="absolute -right-1 -top-1 hidden rounded-full bg-destructive p-0.5 text-destructive-foreground shadow group-hover:flex"
          >
            <X size={10} />
          </button>
        </div>
      ))}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add apps/web/src/components/chat/AttachmentPreview.tsx
git commit -m "feat: add AttachmentPreview component for composer thumbnail strip"
```

---

## Task 9: Composer Paste & Drop Handlers

Add image paste, drag-and-drop, and attachment state to the Composer.

**Files:**
- Modify: `apps/web/src/components/chat/Composer.tsx`

**Step 1: Add imports and constants**

Add at the top of `Composer.tsx`:

```typescript
import { AttachmentPreview } from "./AttachmentPreview";
import type { PendingAttachment } from "./AttachmentPreview";
import type { AttachmentMeta } from "@/transport";
import { getTransport } from "@/transport";

const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const SUPPORTED_FILE_TYPES = new Set(["application/pdf", "text/plain"]);
const ALL_SUPPORTED_TYPES = new Set([...SUPPORTED_IMAGE_TYPES, ...SUPPORTED_FILE_TYPES]);
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;     // 5 MB
const MAX_PDF_SIZE = 32 * 1024 * 1024;       // 32 MB
const MAX_TEXT_SIZE = 1 * 1024 * 1024;        // 1 MB
const MAX_ATTACHMENTS = 5;
```

**Step 2: Add attachment state**

Inside the `Composer` function, add after the existing state declarations (after line 40):

```typescript
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepthRef = useRef(0);
```

**Step 3: Add validation helper**

Add inside the `Composer` function:

```typescript
  const getMaxSize = (mimeType: string): number => {
    if (SUPPORTED_IMAGE_TYPES.has(mimeType)) return MAX_IMAGE_SIZE;
    if (mimeType === "application/pdf") return MAX_PDF_SIZE;
    if (mimeType === "text/plain") return MAX_TEXT_SIZE;
    return 0;
  };

  const addFiles = useCallback((files: File[], filePaths?: (string | null)[]) => {
    setAttachments((prev) => {
      const remaining = MAX_ATTACHMENTS - prev.length;
      if (remaining <= 0) return prev;

      const newAttachments: PendingAttachment[] = [];
      for (let i = 0; i < Math.min(files.length, remaining); i++) {
        const file = files[i];
        if (!ALL_SUPPORTED_TYPES.has(file.type)) continue;

        const maxSize = getMaxSize(file.type);
        if (file.size > maxSize) continue;

        const previewUrl = file.type.startsWith("image/")
          ? URL.createObjectURL(file)
          : "";

        newAttachments.push({
          id: crypto.randomUUID(),
          name: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          previewUrl,
          filePath: filePaths?.[i] ?? null,
        });
      }

      return [...prev, ...newAttachments];
    });
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const removed = prev.find((a) => a.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);
```

**Step 4: Add paste handler**

```typescript
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));

    if (imageFiles.length > 0) {
      e.preventDefault();

      // Try to get file paths via preload
      const api = window.electronAPI;
      if (api?.getPathForFile) {
        const paths = imageFiles.map((f) => {
          try { return api.getPathForFile(f); } catch { return null; }
        });
        addFiles(imageFiles, paths);
      } else {
        // Clipboard paste without file path: ask main process
        try {
          const meta = await getTransport().readClipboardImage();
          if (meta) {
            setAttachments((prev) => {
              if (prev.length >= MAX_ATTACHMENTS) return prev;
              // Create a blob URL from the clipboard for preview
              const previewUrl = imageFiles[0]
                ? URL.createObjectURL(imageFiles[0])
                : "";
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
          // Fallback: add without file path
          addFiles(imageFiles);
        }
      }
    }
  }, [addFiles]);
```

**Step 5: Add drag handlers**

```typescript
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current += 1;
    if (e.dataTransfer.types.includes("Files")) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current -= 1;
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOver(false);

    const files = Array.from(e.dataTransfer.files);
    const supported = files.filter((f) => ALL_SUPPORTED_TYPES.has(f.type));
    if (supported.length === 0) return;

    const api = window.electronAPI;
    const paths = supported.map((f) => {
      try { return api?.getPathForFile?.(f) ?? null; } catch { return null; }
    });
    addFiles(supported, paths);
    textareaRef.current?.focus();
  }, [addFiles]);
```

**Step 6: Update handleSend to include attachments**

Update `handleSend` to convert pending attachments to `AttachmentMeta[]` and pass them, then clear:

In the `handleSend` callback, after `setInput("");` (line 142), add:

```typescript
    const currentAttachments: AttachmentMeta[] = attachments
      .filter((a) => a.filePath != null)
      .map((a) => ({
        id: a.id,
        name: a.name,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        sourcePath: a.filePath!,
      }));

    // Clean up preview URLs
    for (const att of attachments) {
      if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
    }
    setAttachments([]);
```

Then update the two send calls to pass attachments:

```typescript
    if (isNewThread && workspaceId) {
      // ...worktree prep...
      try {
        await useWorkspaceStore.getState().createAndSendMessage(trimmed, modelId, access, currentAttachments.length > 0 ? currentAttachments : undefined);
      } finally {
        setPreparingWorktree(false);
      }
    } else if (threadId) {
      await sendMessage(threadId, trimmed, modelId, access, currentAttachments.length > 0 ? currentAttachments : undefined);
    }
```

**Step 7: Update the JSX**

Wrap the main composer `div` (line 178) with drag handlers:

```tsx
      <div
        className={cn(
          "rounded-xl bg-muted/50 ring-1 ring-border focus-within:ring-primary/50",
          isDragOver && "ring-2 ring-primary"
        )}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
```

Add `onPaste` to the textarea (line 180):

```tsx
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="Ask for follow-up changes or attach images"
          ...
```

Add the attachment preview strip between the textarea and the controls row:

```tsx
        {/* Attachment previews */}
        <AttachmentPreview
          attachments={attachments}
          onRemove={removeAttachment}
        />

        {/* Drag overlay */}
        {isDragOver && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-primary/10 backdrop-blur-sm">
            <span className="text-sm font-medium text-primary">Drop files here</span>
          </div>
        )}
```

Make the parent div `relative` for the drag overlay positioning.

**Step 8: Update handleSend dependency array**

Add `attachments` to the `handleSend` dependency array.

**Step 9: Commit**

```bash
git add apps/web/src/components/chat/Composer.tsx
git commit -m "feat: add paste, drag-drop, and attachment state to Composer"
```

---

## Task 10: Message Bubble Attachments

Display attachments in user message bubbles.

**Files:**
- Modify: `apps/web/src/components/chat/MessageBubble.tsx`

**Step 1: Update MessageBubble to render attachments**

Replace the user message branch in `MessageBubble.tsx`:

```typescript
import type { Message, StoredAttachment } from "@/transport";
import { Bot, FileText, File } from "lucide-react";
import { MarkdownContent } from "./MarkdownContent";

interface MessageBubbleProps {
  message: Message;
}

function AttachmentDisplay({ attachments }: { attachments: StoredAttachment[] }) {
  const images = attachments.filter((a) => a.mimeType.startsWith("image/"));
  const files = attachments.filter((a) => !a.mimeType.startsWith("image/"));

  return (
    <div className="space-y-2">
      {images.length > 0 && (
        <div className="grid max-w-[320px] grid-cols-2 gap-1.5">
          {images.map((img) => (
            <div key={img.id} className="overflow-hidden rounded-lg">
              <img
                src={`mcode-attachment://${img.id}${extFromMime(img.mimeType)}`}
                alt={img.name}
                className="h-auto max-h-[160px] w-full object-cover"
                loading="lazy"
              />
            </div>
          ))}
        </div>
      )}
      {files.map((file) => (
        <div key={file.id} className="flex items-center gap-1.5 rounded-md bg-primary-foreground/10 px-2 py-1">
          {file.mimeType === "application/pdf" ? (
            <FileText size={14} className="text-primary-foreground/70" />
          ) : (
            <File size={14} className="text-primary-foreground/70" />
          )}
          <span className="truncate text-xs text-primary-foreground/80">{file.name}</span>
        </div>
      ))}
    </div>
  );
}

function extFromMime(mimeType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
  };
  return map[mimeType] ?? "";
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] rounded-2xl bg-primary px-4 py-2.5 text-sm text-primary-foreground">
          {message.attachments && message.attachments.length > 0 && (
            <div className="mb-2">
              <AttachmentDisplay attachments={message.attachments} />
            </div>
          )}
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        </div>
      </div>
    );
  }

  // ... assistant message (unchanged)
```

**Step 2: Commit**

```bash
git add apps/web/src/components/chat/MessageBubble.tsx
git commit -m "feat: render image and file attachments in user message bubbles"
```

---

## Task 11: Custom Protocol for Attachment Images

Register a custom `mcode-attachment://` protocol so the renderer can load persisted attachment images.

**Files:**
- Modify: `apps/desktop/src/main/index.ts`

**Step 1: Register the protocol**

In `apps/desktop/src/main/index.ts`, add in the `app.whenReady().then()` block (before `createWindow()`):

```typescript
  import { protocol, net } from "electron";
  import { readFileSync } from "fs";

  // Register custom protocol for serving attachment images
  protocol.handle("mcode-attachment", (request) => {
    // URL format: mcode-attachment://{attachmentId}.{ext}
    const url = new URL(request.url);
    const filename = url.hostname + url.pathname;

    // Validate filename format (UUID with extension)
    if (!/^[a-f0-9-]+\.\w+$/.test(filename)) {
      return new Response("Invalid attachment ID", { status: 400 });
    }

    // Search all thread directories for the attachment
    const attachmentsBase = join(homedir(), ".mcode", "attachments");
    if (!existsSync(attachmentsBase)) {
      return new Response("Not found", { status: 404 });
    }

    // Walk thread directories to find the file
    const { readdirSync } = require("fs");
    const threadDirs = readdirSync(attachmentsBase, { withFileTypes: true })
      .filter((d: { isDirectory: () => boolean }) => d.isDirectory());

    for (const dir of threadDirs) {
      const filePath = join(attachmentsBase, dir.name, filename);
      if (existsSync(filePath)) {
        const data = readFileSync(filePath);
        const ext = filename.split(".").pop() ?? "";
        const mimeMap: Record<string, string> = {
          jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
          gif: "image/gif", webp: "image/webp", pdf: "application/pdf",
          txt: "text/plain",
        };
        return new Response(data, {
          headers: {
            "Content-Type": mimeMap[ext] ?? "application/octet-stream",
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        });
      }
    }

    return new Response("Not found", { status: 404 });
  });
```

**Step 2: Commit**

```bash
git add apps/desktop/src/main/index.ts
git commit -m "feat: register mcode-attachment:// protocol for serving attachment images"
```

---

## Task 12: Integration Test

Verify the full pipeline works end-to-end.

**Files:**
- Create: `apps/desktop/src/main/__tests__/attachments.test.ts`

**Step 1: Write integration tests for the message repo**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openMemoryDatabase } from "../store/database.js";
import * as MessageRepo from "../repositories/message-repo.js";
import type Database from "better-sqlite3";

describe("message attachments", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMemoryDatabase();
    // Create a workspace and thread for FK constraints
    db.exec(`
      INSERT INTO workspaces (id, name, path) VALUES ('ws-1', 'test', '/tmp/test');
      INSERT INTO threads (id, workspace_id, title, status, mode, branch, session_name)
        VALUES ('t-1', 'ws-1', 'test', 'active', 'direct', 'main', 'mcode-t-1');
    `);
  });

  afterEach(() => {
    db.close();
  });

  it("creates a message without attachments", () => {
    const msg = MessageRepo.create(db, "t-1", "user", "hello", 1);
    expect(msg.attachments).toBeNull();
  });

  it("creates a message with attachments", () => {
    const attachments = [
      { id: "att-1", name: "screenshot.png", mimeType: "image/png", sizeBytes: 1024 },
      { id: "att-2", name: "doc.pdf", mimeType: "application/pdf", sizeBytes: 2048 },
    ];
    const msg = MessageRepo.create(db, "t-1", "user", "check these", 1, attachments);

    expect(msg.attachments).toHaveLength(2);
    expect(msg.attachments![0].name).toBe("screenshot.png");
    expect(msg.attachments![1].mimeType).toBe("application/pdf");
  });

  it("round-trips attachments through listByThread", () => {
    const attachments = [
      { id: "att-1", name: "photo.jpg", mimeType: "image/jpeg", sizeBytes: 512 },
    ];
    MessageRepo.create(db, "t-1", "user", "look at this", 1, attachments);

    const messages = MessageRepo.listByThread(db, "t-1", 10);
    expect(messages).toHaveLength(1);
    expect(messages[0].attachments).toHaveLength(1);
    expect(messages[0].attachments![0].id).toBe("att-1");
  });

  it("handles the V3 migration on an existing database", () => {
    // V3 migration already ran in openMemoryDatabase, verify the column exists
    const row = db.prepare("SELECT attachments FROM messages LIMIT 0").get();
    // Should not throw - column exists
    expect(row).toBeUndefined(); // no rows yet, but query succeeded
  });
});
```

**Step 2: Run tests**

```bash
cd apps/desktop && bun run test -- --run src/main/__tests__/attachments.test.ts
```

Expected: All 4 tests pass.

**Step 3: Commit**

```bash
git add apps/desktop/src/main/__tests__/attachments.test.ts
git commit -m "test: add integration tests for message attachment storage"
```

---

## Task 13: Final Verification

**Step 1: Run all tests**

```bash
bun run test
```

Expected: All existing + new tests pass.

**Step 2: Build check**

```bash
bun run build
```

Expected: No TypeScript errors, build succeeds.

**Step 3: Manual smoke test**

1. Start the dev app: `bun run dev`
2. Open a workspace, start a new thread
3. Paste an image from clipboard into the composer - should see thumbnail preview
4. Drag an image file onto the composer - should see thumbnail preview
5. Click the X to remove an attachment - should disappear
6. Send a message with an image - should display in the message bubble
7. Verify the SDK receives the image (check logs for "Starting SDK query" with attachments)

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: address issues found during smoke testing"
```
