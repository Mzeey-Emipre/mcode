import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";
import type { LexicalEditor } from "lexical";
import type { MessageMention, SelectedTextComment } from "@mcode/contracts";
import { Check, Trash2, X } from "lucide-react";
import {
  ComposerEditor,
  createMentionNodeData,
  insertMentionNode,
  insertSelectedPluginMention,
  insertSlashCommandNode,
} from "@/components/chat/lexical";
import { FileTagPopup, useFileTagPopup } from "@/components/chat/FileTagPopup";
import { SlashCommandPopup } from "@/components/chat/SlashCommandPopup";
import { handleSlashCommandPopupKey, type Command, useSlashCommand } from "@/components/chat/useSlashCommand";
import { useFileAutocomplete, type MentionSuggestion } from "@/components/chat/useFileAutocomplete";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { SelectedTextCommentEditorDraft } from "@/stores/composerDraftStore";
import { writeComposerContent } from "@/features/conversation/composer/draft/composer-editor-content";
import type { SelectedTextCommentSource } from "../selected-text-projection";
import {
  buildSelectedTextComment,
  canSaveSelectedTextComment,
  decideCommentDismissal,
  type CommentDismissalFamily,
} from "./comment-editor-model";

const EMPTY_MENTIONS: readonly MessageMention[] = [];
const COMMENT_EDITOR_VERTICAL_CHROME = 10;

/** Props for the compact editor that creates or updates one selected-text comment. */
export interface SelectedTextCommentEditorProps {
  /** Immutable source captured from the pointer selection. */
  readonly source: SelectedTextCommentSource;
  /** Saved comment to edit. Omit for a new comment. */
  readonly comment?: SelectedTextComment;
  /** Persisted editor state to restore after a thread switch. */
  readonly draft?: SelectedTextCommentEditorDraft;
  /** Creation-order display number for a new saved comment. */
  readonly nextDisplayNumber?: number;
  /** Workspace that scopes mention and slash suggestions. */
  readonly workspaceId?: string;
  /** Provider that scopes mention and slash suggestions. */
  readonly providerId?: string;
  /** Maximum visible editor height derived from the transcript viewport. */
  readonly maxHeight?: number;
  /** Receives the compact Lexical editor for owner-managed focus. */
  readonly editorRef?: MutableRefObject<LexicalEditor | null>;
  /** Receives the rendered editor element for current-size positioning. */
  readonly onElementChange?: (element: HTMLElement | null) => void;
  /** Stores the saved comment state. */
  readonly onSave: (comment: SelectedTextComment) => void;
  /** Removes the saved comment state. */
  readonly onDelete?: (comment: SelectedTextComment) => void;
  /** Persists note, mention, and dismissal-warning changes without saving the comment. */
  readonly onDraftChange?: (draft: SelectedTextCommentEditorDraft) => void;
  /** Closes the editor and optionally restores focus to its invoker. */
  readonly onClose: (options?: { readonly restoreFocus?: boolean }) => void;
  /** Announces editor state changes to the persistent live region. */
  readonly onAnnouncement: (message: string) => void;
}

function mentionsMatch(left: readonly MessageMention[], right: readonly MessageMention[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function savedCommentContent(comment: SelectedTextComment | undefined) {
  return {
    note: comment?.note ?? "",
    mentions: comment?.mentions ?? EMPTY_MENTIONS,
  };
}

function isPopupTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("[data-file-popup], [data-slash-popup]"));
}

function useCommentDismissal({
  rootRef,
  isDirty,
  isPopupOpenRef,
  onClose,
  onAnnouncement,
  onWarningsChange,
  initialEscapeWarned = false,
  initialOutsideWarned = false,
}: {
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly isDirty: boolean;
  readonly isPopupOpenRef: RefObject<boolean>;
  readonly onClose: () => void;
  readonly onAnnouncement: (message: string) => void;
  readonly onWarningsChange?: (escapeWarned: boolean, outsideWarned: boolean) => void;
  readonly initialEscapeWarned?: boolean;
  readonly initialOutsideWarned?: boolean;
}) {
  const [escapeWarned, setEscapeWarned] = useState(initialEscapeWarned);
  const [outsideWarned, setOutsideWarned] = useState(initialOutsideWarned);
  const [isShaking, setIsShaking] = useState(false);

  const resetWarnings = useCallback(() => {
    setEscapeWarned(false);
    setOutsideWarned(false);
    setIsShaking(false);
    onWarningsChange?.(false, false);
  }, [onWarningsChange]);

  const requestDismissal = useCallback((family: CommentDismissalFamily) => {
    const decision = decideCommentDismissal({
      family,
      isDirty,
      escapeWarned,
      outsideWarned,
    });
    if (decision.kind === "close") {
      resetWarnings();
      onClose();
      return;
    }
    setIsShaking(false);
    requestAnimationFrame(() => setIsShaking(true));
    if (family === "escape") {
      setEscapeWarned(true);
      onWarningsChange?.(true, outsideWarned);
    } else {
      setOutsideWarned(true);
      onWarningsChange?.(escapeWarned, true);
    }
    onAnnouncement(decision.announcement);
  }, [escapeWarned, isDirty, onAnnouncement, onClose, onWarningsChange, outsideWarned, resetWarnings]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isPopupOpenRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      requestDismissal("escape");
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (rootRef.current?.contains(target as Node) || isPopupTarget(target)) return;
      if (isDirty && !outsideWarned) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      requestDismissal("outside");
    };
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [isDirty, isPopupOpenRef, outsideWarned, requestDismissal, rootRef]);

  return { isShaking, requestDismissal, resetWarnings };
}

function CommentEditorComposer({
  source,
  workspaceId,
  providerId,
  savedNote,
  savedMentions,
  editorRef,
  contentEditableRef,
  rootRef,
  isPopupOpenRef,
  maxHeight,
  onChange,
  onSubmit,
}: {
  readonly source: SelectedTextCommentSource;
  readonly workspaceId?: string;
  readonly providerId?: string;
  readonly savedNote: string;
  readonly savedMentions: readonly MessageMention[];
  readonly editorRef: MutableRefObject<LexicalEditor | null>;
  readonly contentEditableRef: React.Ref<HTMLDivElement>;
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly isPopupOpenRef: RefObject<boolean>;
  readonly maxHeight?: number;
  readonly onChange: (note: string, mentions: MessageMention[]) => void;
  readonly onSubmit: () => void;
}) {
  const fileAutocomplete = useFileAutocomplete({ workspaceId, threadId: source.threadId, providerId });
  const slashCommand = useSlashCommand({
    anchorRef: rootRef,
    workspaceId,
    threadId: source.threadId,
    providerId: providerId ?? "selected-text-comment",
    includeBuiltins: false,
  });
  isPopupOpenRef.current = fileAutocomplete.isOpen || slashCommand.isOpen;

  useEffect(() => {
    const frame = requestAnimationFrame(() => editorRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [editorRef]);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor) writeComposerContent(editor, savedNote, savedMentions);
  }, [editorRef, savedMentions, savedNote]);

  const handleMentionSelect = useCallback((item: MentionSuggestion) => {
    const editor = editorRef.current;
    if (!editor) return;
    fileAutocomplete.selectSuggestion(item);
    insertMentionNode(editor, createMentionNodeData(item), fileAutocomplete.triggerStart, fileAutocomplete.query.length);
  }, [editorRef, fileAutocomplete]);

  const filePopup = useFileTagPopup({
    items: fileAutocomplete.suggestions,
    query: fileAutocomplete.query,
    isOpen: fileAutocomplete.isOpen,
    onSelect: handleMentionSelect,
    onDismiss: fileAutocomplete.dismiss,
  });

  const handleSlashSelect = useCallback((command: Command) => {
    const editor = editorRef.current;
    if (!editor) return;
    slashCommand.onSelect(command, () => {});
    if (!insertSelectedPluginMention(editor, command)) {
      insertSlashCommandNode(editor, command.name, command.namespace, command.identity);
    }
  }, [editorRef, slashCommand]);

  const handlePopupKeyDown = useCallback((key: string): boolean => {
    if (fileAutocomplete.isOpen) {
      return filePopup.handleKeyDown({
        key,
        preventDefault: () => {},
        stopPropagation: () => {},
      } as unknown as React.KeyboardEvent);
    }
    if (slashCommand.isOpen) {
      return handleSlashCommandPopupKey(
        key,
        slashCommand.items,
        slashCommand.selectedIndex,
        handleSlashSelect,
        slashCommand.onDismiss,
        slashCommand.onKeyDown,
      );
    }
    return false;
  }, [fileAutocomplete.isOpen, filePopup, handleSlashSelect, slashCommand]);

  const popupAnchorRect = fileAutocomplete.isOpen
    ? rootRef.current?.getBoundingClientRect() ?? null
    : null;

  return (
    <>
      <ComposerEditor
        onChange={onChange}
        onSubmit={onSubmit}
        onMentionTrigger={fileAutocomplete.handleInputChange}
        onMentionDismiss={fileAutocomplete.dismiss}
        isMentionPopupOpen={fileAutocomplete.isOpen}
        onSlashTrigger={slashCommand.onInputChange}
        onSlashDismiss={slashCommand.onDismiss}
        isSlashPopupOpen={slashCommand.isOpen}
        editorRef={editorRef}
        contentEditableRef={contentEditableRef}
        autoFocus
        id="selected-text-comment-note"
        ariaLabel="Comment note"
        placeholder="Write a note"
        submitOnEnter={false}
        compact
        compactMaxHeight={maxHeight}
        isPopupOpen={isPopupOpenRef.current}
        onPopupKeyDown={handlePopupKeyDown}
      />
      <FileTagPopup
        items={fileAutocomplete.suggestions}
        isOpen={fileAutocomplete.isOpen}
        onSelect={handleMentionSelect}
        listRef={filePopup.listRef}
        selectedIndex={filePopup.selectedIndex}
        anchorRect={popupAnchorRect}
        presentation="compact"
      />
      <SlashCommandPopup
        state={slashCommand.state}
        selectedIndex={slashCommand.selectedIndex}
        anchorRect={slashCommand.anchorRect}
        onSelect={handleSlashSelect}
        onDismiss={slashCommand.onDismiss}
        onRetry={slashCommand.onRetry}
      />
    </>
  );
}

function CommentEditorControls({
  comment,
  canSave,
  onSave,
  onDelete,
  onClose,
}: {
  readonly comment?: SelectedTextComment;
  readonly canSave: boolean;
  readonly onSave: () => void;
  readonly onDelete?: () => void;
  readonly onClose: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {canSave && (
        <Tooltip>
          <TooltipTrigger
            render={(
              <Button
                type="button"
                size="icon-xs"
                className="order-2 rounded-full"
                aria-label={comment ? "Save comment" : "Add comment"}
                onClick={onSave}
              >
                <Check size={13} aria-hidden />
              </Button>
            )}
          />
          <TooltipContent>{comment ? "Save comment" : "Add comment"}</TooltipContent>
        </Tooltip>
      )}
      {comment && onDelete && (
        <Tooltip>
          <TooltipTrigger
            render={(
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="order-3 rounded-full text-destructive hover:text-destructive"
                aria-label="Delete comment"
                onClick={onDelete}
              >
                <Trash2 size={14} aria-hidden />
              </Button>
            )}
          />
          <TooltipContent>Delete comment</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger
          render={(
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="order-1 rounded-full"
              aria-label="Close comment editor"
              onClick={onClose}
            >
              <X size={14} aria-hidden />
            </Button>
          )}
        />
        <TooltipContent>Close comment editor</TooltipContent>
      </Tooltip>
    </div>
  );
}

function useSelectedTextCommentContent(
  comment: SelectedTextComment | undefined,
  draft: SelectedTextCommentEditorDraft | undefined,
) {
  const { note: savedNote, mentions: savedMentions } = savedCommentContent(comment);
  const initialContentRef = useRef({
    note: draft?.note ?? savedNote,
    mentions: [...(draft?.mentions ?? savedMentions)],
  });
  const [note, setNote] = useState(initialContentRef.current.note);
  const [mentions, setMentions] = useState<MessageMention[]>(initialContentRef.current.mentions);
  return {
    initialContent: initialContentRef.current,
    note,
    mentions,
    setNote,
    setMentions,
    canSave: canSaveSelectedTextComment(note, mentions),
    isDirty: note !== savedNote || !mentionsMatch(mentions, savedMentions),
  };
}

function createEditorDraft(
  source: SelectedTextCommentSource,
  comment: SelectedTextComment | undefined,
  draft: SelectedTextCommentEditorDraft | undefined,
  note: string,
  mentions: MessageMention[],
  escapeWarned: boolean,
  outsideWarned: boolean,
): SelectedTextCommentEditorDraft {
  return {
    source,
    commentId: comment?.id,
    note,
    mentions,
    escapeWarned,
    outsideWarned,
    anchor: draft?.anchor ?? "source",
  };
}

function useSelectedTextCommentEditorActions({
  source,
  comment,
  draft,
  nextDisplayNumber,
  note,
  mentions,
  canSave,
  setNote,
  setMentions,
  resetWarnings,
  onDraftChange,
  onSave,
  onDelete,
  onClose,
  onAnnouncement,
}: {
  readonly source: SelectedTextCommentSource;
  readonly comment: SelectedTextComment | undefined;
  readonly draft: SelectedTextCommentEditorDraft | undefined;
  readonly nextDisplayNumber: number;
  readonly note: string;
  readonly mentions: MessageMention[];
  readonly canSave: boolean;
  readonly setNote: (note: string) => void;
  readonly setMentions: (mentions: MessageMention[]) => void;
  readonly resetWarnings: () => void;
  readonly onDraftChange: SelectedTextCommentEditorProps["onDraftChange"];
  readonly onSave: (comment: SelectedTextComment) => void;
  readonly onDelete: SelectedTextCommentEditorProps["onDelete"];
  readonly onClose: SelectedTextCommentEditorProps["onClose"];
  readonly onAnnouncement: (message: string) => void;
}) {
  const persist = useCallback((nextNote: string, nextMentions: MessageMention[]) => {
    const nextDraft = createEditorDraft(
      source,
      comment,
      draft,
      nextNote,
      nextMentions,
      false,
      false,
    );
    onDraftChange?.(nextDraft);
  }, [comment, draft, onDraftChange, source]);
  const handleChange = useCallback((nextNote: string, nextMentions: MessageMention[]) => {
    setNote(nextNote);
    setMentions(nextMentions);
    resetWarnings();
    persist(nextNote, nextMentions);
  }, [persist, resetWarnings, setMentions, setNote]);
  const save = useCallback(() => {
    if (!canSave) return;
    const nextComment = buildSelectedTextComment({
      comment,
      source,
      note,
      mentions,
      displayNumber: nextDisplayNumber,
    });
    resetWarnings();
    onSave(nextComment);
    onAnnouncement(`Comment ${nextComment.displayNumber} ${comment ? "updated" : "added"}.`);
    if (comment) onClose();
    else onClose({ restoreFocus: false });
  }, [canSave, comment, mentions, nextDisplayNumber, note, onAnnouncement, onClose, onSave, resetWarnings, source]);
  const deleteComment = useCallback(() => {
    if (!comment || !onDelete) return;
    resetWarnings();
    onDelete(comment);
    onAnnouncement("Comment deleted.");
    onClose({ restoreFocus: false });
  }, [comment, onAnnouncement, onClose, onDelete, resetWarnings]);
  return { handleChange, save, deleteComment };
}

/** Renders the prototype compact ComposerEditor and comment dismissal policy. */
export function SelectedTextCommentEditor({
  source,
  comment,
  draft,
  nextDisplayNumber = 1,
  workspaceId,
  providerId,
  maxHeight,
  editorRef: providedEditorRef,
  onSave,
  onDelete,
  onDraftChange,
  onClose,
  onElementChange,
  onAnnouncement,
}: SelectedTextCommentEditorProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const ownedEditorRef = useRef<LexicalEditor | null>(null);
  const editorRef = providedEditorRef ?? ownedEditorRef;
  const setRootElement = useCallback((element: HTMLElement | null) => {
    rootRef.current = element;
    onElementChange?.(element);
  }, [onElementChange]);
  const focusNoteOnMount = useCallback((element: HTMLDivElement | null) => {
    element?.focus();
  }, []);
  const isPopupOpenRef = useRef(false);
  const content = useSelectedTextCommentContent(comment, draft);
  const { isShaking, resetWarnings } = useCommentDismissal({
    rootRef,
    isDirty: content.isDirty,
    isPopupOpenRef,
    onClose,
    onAnnouncement,
    onWarningsChange: (escapeWarned, outsideWarned) => {
      onDraftChange?.(createEditorDraft(
        source,
        comment,
        draft,
        content.note,
        content.mentions,
        escapeWarned,
        outsideWarned,
      ));
    },
    initialEscapeWarned: draft?.escapeWarned,
    initialOutsideWarned: draft?.outsideWarned,
  });
  const { handleChange, save, deleteComment } = useSelectedTextCommentEditorActions({
    source,
    comment,
    draft,
    nextDisplayNumber,
    note: content.note,
    mentions: content.mentions,
    canSave: content.canSave,
    setNote: content.setNote,
    setMentions: content.setMentions,
    resetWarnings,
    onDraftChange,
    onSave,
    onDelete,
    onClose,
    onAnnouncement,
  });

  return (
    <section
      ref={setRootElement}
      role="dialog"
      aria-label="Comment on selected text"
      style={{ maxHeight }}
      className={cn(
        "relative overflow-hidden rounded-2xl border border-border/70 bg-popover text-popover-foreground shadow-lg",
        isShaking && "animate-preview-annotation-shake",
      )}
    >
      <div className="flex items-center gap-1.5 px-2 py-1">
        <div className="min-w-0 flex-1 overflow-hidden">
          <CommentEditorComposer
            source={source}
            workspaceId={workspaceId}
            providerId={providerId}
            savedNote={content.initialContent.note}
            savedMentions={content.initialContent.mentions}
            editorRef={editorRef}
            contentEditableRef={focusNoteOnMount}
            rootRef={rootRef}
            isPopupOpenRef={isPopupOpenRef}
            maxHeight={maxHeight === undefined ? undefined : Math.max(0, maxHeight - COMMENT_EDITOR_VERTICAL_CHROME)}
            onChange={handleChange}
            onSubmit={save}
          />
        </div>
        <CommentEditorControls
          comment={comment}
          canSave={content.canSave}
          onSave={save}
          onDelete={onDelete ? deleteComment : undefined}
          onClose={onClose}
        />
      </div>
    </section>
  );
}
