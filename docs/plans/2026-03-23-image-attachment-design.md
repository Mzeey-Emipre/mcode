# Image & File Attachment Design

## Problem

Users cannot attach images or files to chat messages. The Claude API supports multimodal content (images, PDFs, plain text files), but the entire pipeline, from Composer to SidecarClient, passes only plain strings.

## Approach: File-Path-First

Electron gives us direct filesystem access. Instead of sending image bytes over IPC (like T3 Code does over WebSocket), we pass only file paths. The main process reads files from disk right before building the SDK payload. This keeps IPC payloads small and avoids duplicating image data across processes.

### Supported content types

| Type | Formats | Max size | SDK block type |
|------|---------|----------|----------------|
| Image | JPEG, PNG, GIF, WebP | 5 MB | `image` |
| PDF | `application/pdf` | 32 MB, 100 pages | `document` |
| Plain text | `text/plain` | ~100K tokens | `document` |

Max 5 attachments per message.

## Architecture

### Data flow

```
Renderer (Composer)
  ├─ Drag-drop: webUtils.getPathForFile(file) → file path
  ├─ Clipboard paste: IPC signal → main reads clipboard → temp file path
  └─ File picker: dialog.showOpenDialog → file path
        │
        ▼
IPC: send-message(threadId, content, ..., attachments: AttachmentMeta[])
        │  ~100 bytes per attachment (path + metadata, no binary data)
        ▼
Main process (AppState)
  ├─ Validate file exists, size, MIME type
  ├─ Copy to persistent storage: {userData}/attachments/{threadId}/{id}.{ext}
  ├─ Save message + attachment metadata JSON to SQLite
  └─ Pass to SidecarClient
        │
        ▼
SidecarClient
  ├─ Read file from disk → Buffer
  ├─ Convert to base64
  ├─ Build SDKUserMessage with content blocks
  └─ Pass to query() via AsyncIterable<SDKUserMessage>
```

### Why AsyncIterable?

The Claude Agent SDK's `query()` function accepts `prompt: string | AsyncIterable<SDKUserMessage>`. A plain string cannot carry image content. The `SDKUserMessage` type wraps `MessageParam` from the Anthropic SDK, which supports `content: ContentBlockParam[]` with image and document blocks.

Current code: `query({ prompt: message, options })`
New code: `query({ prompt: buildUserMessages(message, attachments), options })`

## Frontend

### Composer changes

**Entry points:**

1. **Clipboard paste** - `onPaste` on textarea, filter `clipboardData.files` for supported MIME types.
2. **Drag-and-drop** - `onDrop` on the Composer wrapper. Track drag depth with a ref counter for nested enter/leave events.
3. **File picker** - Button in toolbar (future, not in initial scope).

**Pending attachments state:**

```typescript
type PendingAttachment = {
  id: string;             // crypto.randomUUID()
  name: string;           // filename or "clipboard-{timestamp}.png"
  mimeType: string;
  sizeBytes: number;
  previewUrl: string;     // blob: URL for images, empty for files
  filePath: string | null; // from webUtils.getPathForFile, null for clipboard
}
```

**Validation rules:**
- Max 5 attachments per message
- Images: max 5 MB, JPEG/PNG/GIF/WebP only
- PDFs: max 32 MB
- Text files: max 1 MB
- Reject with toast on invalid type or size

**Cleanup:** Call `URL.revokeObjectURL(previewUrl)` on send or remove.

### Attachment preview strip

Renders between the textarea and toolbar when attachments exist:

```
┌─────────────────────────────────────────────────┐
│  [Message textarea...]                          │
├─────────────────────────────────────────────────┤
│ ┌──────┐ ┌──────┐ ┌────────────┐               │
│ │ thumb│ │ thumb│ │ 📄 doc.pdf │  ← strip      │
│ │  ×   │ │  ×   │ │     ×      │               │
│ └──────┘ └──────┘ └────────────┘               │
├─────────────────────────────────────────────────┤
│ [Model] [Reasoning] [Mode] [Permissions]        │
└─────────────────────────────────────────────────┘
```

- Images: 64x64 thumbnail with `object-cover`, remove button
- Files: icon + truncated filename, remove button
- Drag-over: border highlight with "Drop files here" overlay

### Message display

User messages with attachments render them above the text content:

- Images: 2-column grid, max 220px height, click to expand in lightbox
- Files: pill with icon and filename

Attachment images served via `mcode-attachment://` custom protocol registered in main process, mapped to the persistent attachments directory.

## Backend

### IPC contract

**Modified channels:**

```typescript
// Both gain an optional attachments parameter
"send-message": (threadId, content, model?, permissionMode?, attachments?: AttachmentMeta[])
"create-and-send-message": (workspaceId, content, model, permissionMode?, mode?, branch?, attachments?: AttachmentMeta[])

// New channel: renderer signals clipboard paste, main reads and returns metadata
"read-clipboard-image": () => AttachmentMeta | null
```

**AttachmentMeta (the IPC payload):**

```typescript
type AttachmentMeta = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sourcePath: string;  // absolute path to file on disk
}
```

### Preload additions

```typescript
// Expose webUtils.getPathForFile for drag-drop file path extraction
getPathForFile: (file: File) => string
```

### Database

Add `attachments` TEXT column to the `messages` table. Stores JSON array of metadata (no binary data).

```sql
ALTER TABLE messages ADD COLUMN attachments TEXT;
```

Stored format:

```typescript
type StoredAttachment = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}
```

### Persistent file storage

Location: `{app.getPath('userData')}/attachments/{threadId}/{attachmentId}.{ext}`

Path traversal protection: validate attachment IDs match `^[a-f0-9-]+$` before constructing paths.

Cleanup: when a thread is deleted, delete its attachments directory.

### SidecarClient changes

```typescript
async *buildUserMessages(
  message: string,
  attachments: AttachmentMeta[],
  sessionId: string
): AsyncGenerator<SDKUserMessage> {
  const contentBlocks: ContentBlockParam[] = [];

  for (const att of attachments) {
    const data = await readFile(att.sourcePath);
    const base64 = data.toString("base64");

    if (att.mimeType.startsWith("image/")) {
      contentBlocks.push({
        type: "image",
        source: { type: "base64", media_type: att.mimeType, data: base64 }
      });
    } else if (att.mimeType === "application/pdf") {
      contentBlocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: base64 }
      });
    } else if (att.mimeType === "text/plain") {
      contentBlocks.push({
        type: "document",
        source: { type: "text", media_type: "text/plain", data: data.toString("utf-8") }
      });
    }
  }

  contentBlocks.push({ type: "text", text: message });

  yield {
    type: "user",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { role: "user", content: contentBlocks }
  };
}
```

## Transport layer

**Electron transport** (`apps/web/src/transport/electron.ts`): extend `sendMessage` and `createAndSendMessage` to accept and pass `AttachmentMeta[]`.

**Transport types** (`apps/web/src/transport/types.ts`): add `AttachmentMeta` type and update method signatures.

## Files changed

| File | Change |
|------|--------|
| `apps/web/src/components/chat/Composer.tsx` | Paste, drop handlers, attachment state, preview strip |
| `apps/web/src/components/chat/AttachmentPreview.tsx` | New: thumbnail/pill strip component |
| `apps/web/src/components/chat/ImageLightbox.tsx` | New: expanded image viewer |
| `apps/web/src/components/chat/MessageContent.tsx` | Render attachments in user messages |
| `apps/web/src/transport/types.ts` | Add AttachmentMeta, update method signatures |
| `apps/web/src/transport/electron.ts` | Pass attachments through IPC |
| `apps/desktop/src/preload/index.ts` | Expose `getPathForFile` |
| `apps/desktop/src/main/index.ts` | Update IPC handlers, add `read-clipboard-image` |
| `apps/desktop/src/main/app-state.ts` | Handle attachments in send flow |
| `apps/desktop/src/main/models.ts` | Add AttachmentMeta type |
| `apps/desktop/src/main/sidecar/client.ts` | Switch to AsyncIterable, build content blocks |
| `apps/desktop/src/main/repositories/message-repo.ts` | Store/retrieve attachment metadata |
| `apps/desktop/src/main/store/database.ts` | Add migration for attachments column |
