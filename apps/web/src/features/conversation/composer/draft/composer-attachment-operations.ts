import type { PendingAttachment } from "@/components/chat/AttachmentPreview";
import type { AttachmentMeta } from "@/transport";
import {
  classifyFile,
  getMaxFileSize,
  inferMimeType,
  isFileSupported,
  isVirtualBrowserContextAttachment,
  MCODE_BROWSER_CONTEXT_ATTACHMENT_MIME,
} from "@mcode/contracts";

/** Inputs for preparing file rows before the Composer persists pathless files. */
export interface ComposerAttachmentSelectionInput {
  files: readonly File[];
  filePaths?: readonly (string | null)[];
  availableSlots: number;
}

/** File rows that can enter the Composer tray now or after persistence. */
export interface ComposerAttachmentSelection {
  nativeAttachments: PendingAttachment[];
  pathlessFiles: File[];
}

/** Callbacks that persist pathless file rows while their Composer owner remains current. */
export interface PathlessComposerAttachmentPreparationInput {
  files: readonly File[];
  isCurrent(): boolean;
  persist(file: File, mimeType: string): Promise<AttachmentMeta | null>;
  reportFailure(): void;
  commit(prepared: PendingAttachment[]): void;
}

type PathlessComposerAttachmentPreparationStep = Omit<
  PathlessComposerAttachmentPreparationInput,
  "files" | "commit"
>;

function isContextOnlyBrowserAttachment(attachment: PendingAttachment): boolean {
  return (
    !!attachment.browserCapture
    && attachment.filePath == null
    && (attachment.contextOnly === true
      || isVirtualBrowserContextAttachment(attachment.mimeType)
      || attachment.name === "Page context")
  );
}

function revokeAttachmentPreviews(attachments: readonly PendingAttachment[]): void {
  for (const attachment of attachments) {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }
}

async function preparePathlessComposerAttachment(
  file: File,
  { isCurrent, persist, reportFailure }: PathlessComposerAttachmentPreparationStep,
): Promise<PendingAttachment | null> {
  try {
    const mimeType = file.type || inferMimeType(file.name);
    const meta = await persist(file, mimeType);
    if (!meta?.sourcePath || !isCurrent()) return null;

    const previewUrl = classifyFile(file.name) === "image" ? URL.createObjectURL(file) : "";
    if (!isCurrent()) {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      return null;
    }
    return {
      id: meta.id,
      name: meta.name,
      mimeType: meta.mimeType,
      sizeBytes: meta.sizeBytes,
      previewUrl,
      filePath: meta.sourcePath,
    };
  } catch {
    if (isCurrent()) reportFailure();
    return null;
  }
}

/** Converts staged Composer attachments into durable transport metadata. */
export function toComposerAttachmentMetas(attachments: readonly PendingAttachment[]): AttachmentMeta[] {
  const metas: AttachmentMeta[] = [];
  for (const attachment of attachments) {
    if (isContextOnlyBrowserAttachment(attachment)) {
      metas.push({
        id: attachment.id,
        name: attachment.name,
        mimeType: MCODE_BROWSER_CONTEXT_ATTACHMENT_MIME,
        sizeBytes: 0,
        sourcePath: "",
      });
      continue;
    }
    if (attachment.filePath != null) {
      metas.push({
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        sourcePath: attachment.filePath,
      });
    }
  }
  return metas;
}

/** Separates supported file rows that are ready for the tray from rows that require persistence. */
export function selectComposerAttachments({
  files,
  filePaths,
  availableSlots,
}: ComposerAttachmentSelectionInput): ComposerAttachmentSelection {
  const nativeAttachments: PendingAttachment[] = [];
  const pathlessFiles: File[] = [];

  for (const [index, file] of files.entries()) {
    if (nativeAttachments.length + pathlessFiles.length >= availableSlots) break;
    if (!isFileSupported(file.name) || file.size > getMaxFileSize(file.name)) continue;

    const nativePath = filePaths?.[index] ?? null;
    if (!nativePath) {
      pathlessFiles.push(file);
      continue;
    }

    nativeAttachments.push({
      id: crypto.randomUUID(),
      name: file.name,
      mimeType: file.type || inferMimeType(file.name),
      sizeBytes: file.size,
      previewUrl: classifyFile(file.name) === "image" ? URL.createObjectURL(file) : "",
      filePath: nativePath,
    });
  }

  return { nativeAttachments, pathlessFiles };
}

/** Persists pathless rows and commits only attachments that still belong to the current Composer owner. */
export async function preparePathlessComposerAttachments({
  files,
  isCurrent,
  persist,
  reportFailure,
  commit,
}: PathlessComposerAttachmentPreparationInput): Promise<void> {
  const prepared: PendingAttachment[] = [];

  for (const file of files) {
    const attachment = await preparePathlessComposerAttachment(file, {
      isCurrent,
      persist,
      reportFailure,
    });
    if (attachment) prepared.push(attachment);
  }

  if (isCurrent()) {
    commit(prepared);
    return;
  }
  revokeAttachmentPreviews(prepared);
}
