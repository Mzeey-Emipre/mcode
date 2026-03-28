# Fix: Pasting PDFs and text files into composer

**Date:** 2026-03-28
**Issue:** #70
**Branch:** `fix/pasting-files`

## Problem

Pasting PDFs or text files into the composer is silently ignored. Only images work via paste. Drag-drop works correctly for all supported types.

The root cause is in `handlePaste` (Composer.tsx, line 351) which filters clipboard files to images only:

```typescript
const imageFiles = files.filter((f) => f.type.startsWith("image/"));
```

While `handleDrop` (line 439) correctly uses:

```typescript
const supported = files.filter((f) => ALL_SUPPORTED_TYPES.has(f.type));
```

The downstream pipeline (addFiles, attachment service, Claude provider) handles PDFs and text files correctly. The bug is purely in the paste handler's filter and fallback logic.

## Supported types

Defined in Composer.tsx (lines 42-44):

| Category | MIME types | Max size |
|----------|-----------|----------|
| Images | image/jpeg, image/png, image/gif, image/webp | 5 MB |
| Documents | application/pdf | 32 MB |
| Text | text/plain | 1 MB |

## Design

### Approach: Unified paste handler with `saveClipboardFile`

Restructure `handlePaste` to accept all supported types, then branch on whether a real file path exists. For non-image files that lack a file path (edge case), add a new `saveClipboardFile` method that writes the raw File blob to a temp file and returns `AttachmentMeta`.

### Paste handler flow

```
clipboardData.files
  -> filter by ALL_SUPPORTED_TYPES
  -> if any supported files: e.preventDefault()
  -> try getPathForFile() for each file
  -> partition into: files WITH paths, files WITHOUT paths

Files WITH paths -> addFiles() (existing, unchanged)

Files WITHOUT paths -> partition by type:
  - Images -> readClipboardImage() (existing, unchanged)
  - Non-images -> saveClipboardFile() (new)
```

`e.preventDefault()` is called for any supported file, not just images. This prevents the browser from inserting file content as text into the editor.

### `saveClipboardFile` across the stack

Four layers, following the existing `readClipboardImage` pattern:

**1. Desktop bridge (Electron IPC path)**

New IPC handler `save-clipboard-file` in `apps/desktop/src/main/main.ts`:
- Receives `{ buffer: Uint8Array, mimeType: string, fileName: string }`
- Derives file extension from mime type (`application/pdf` -> `.pdf`, `text/plain` -> `.txt`)
- Writes to `{tempDir}/mcode-attachments/{uuid}.{ext}`
- Returns `AttachmentMeta`

Exposed via preload (`apps/desktop/src/main/preload.ts`) as `desktopBridge.saveClipboardFile()`.

Type declaration added to `apps/web/src/transport/desktop-bridge.d.ts`.

**2. Server RPC (web-only path)**

New method in `packages/contracts/src/ws/methods.ts`:

```typescript
"clipboard.saveFile": {
  params: z.object({
    data: z.string(),      // base64-encoded file content
    mimeType: z.string(),
    fileName: z.string(),
  }),
  result: AttachmentMetaSchema,
}
```

New case in `apps/server/src/transport/ws-router.ts` dispatcher: decodes base64, writes to temp dir, returns `AttachmentMeta`. Logic is small enough to live inline in the dispatcher or as a helper on `fileService`.

**3. Transport interface**

Add `saveClipboardFile()` to `McodeTransport` in `apps/web/src/transport/types.ts`.

Implement in `apps/web/src/transport/ws-transport.ts`:

```typescript
saveClipboardFile: (data, mimeType, fileName) =>
  rpc<AttachmentMeta>("clipboard.saveFile", { data, mimeType, fileName }),
```

**4. Composer consumption**

In `handlePaste`, for non-image files without a path:
1. Read the `File` as ArrayBuffer
2. For desktop bridge: pass as Uint8Array via IPC (structured clone, no encoding overhead)
3. For web transport: convert to base64 string, call RPC
4. Attach the returned `AttachmentMeta`

### Data encoding

- Desktop bridge IPC: raw `Uint8Array` via structured clone (zero overhead)
- WebSocket RPC: base64 string (~33% overhead, but keeps JSON-serializable contract simple)

### Edge cases

**Mixed paste (images + files together):**
Process in two batches. Files with resolved paths go to `addFiles()`. Pathless files go through the type-specific fallback. This generalizes the existing image-only behavior.

**Size validation before transfer:**
Validate file size against per-type limits *before* sending data over IPC/RPC. Avoids transmitting large blobs only to reject them. Use the existing `getMaxSize(mimeType)` helper.

**Attachment count limit:**
Check `prev.length >= MAX_ATTACHMENTS` before calling `saveClipboardFile`. Same as existing `readClipboardImage` path.

**Temp file cleanup:**
Files land in `{tempDir}/mcode-attachments/`. Same lifecycle as `readClipboardImage` temp files. No new cleanup logic needed.

**Unsupported types:**
Filtered out by `ALL_SUPPORTED_TYPES`. Silently ignored (same as current behavior for non-image files in drag-drop).

## Affected files

| File | Change |
|------|--------|
| `apps/web/src/components/chat/Composer.tsx` | Rewrite `handlePaste` to accept all supported types with branching fallback |
| `apps/desktop/src/main/main.ts` | Add `save-clipboard-file` IPC handler |
| `apps/desktop/src/main/preload.ts` | Expose `saveClipboardFile` on bridge |
| `apps/web/src/transport/desktop-bridge.d.ts` | Add `saveClipboardFile` type |
| `apps/web/src/transport/types.ts` | Add `saveClipboardFile` to `McodeTransport` |
| `apps/web/src/transport/ws-transport.ts` | Implement `saveClipboardFile` RPC call |
| `packages/contracts/src/ws/methods.ts` | Add `clipboard.saveFile` method schema |
| `apps/server/src/transport/ws-router.ts` | Add dispatcher case for `clipboard.saveFile` |
| `apps/web/src/__tests__/mocks/transport.ts` | Add `saveClipboardFile` mock to `mockTransport` |

## Tests

No tests exist today for paste/drop behavior. Add tests covering:

- Paste image with path (existing behavior, regression)
- Paste PDF with path (new behavior)
- Paste text file with path (new behavior)
- Paste image without path (existing clipboard fallback, regression)
- Paste non-image without path (new `saveClipboardFile` fallback)
- Unsupported file type pasted (ignored)
- Size limit exceeded (rejected before transfer)
