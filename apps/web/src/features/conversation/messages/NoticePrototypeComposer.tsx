import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { ChevronDown, Info, TriangleAlert, X } from "lucide-react";
import { ComposerOverlaySurface } from "@/components/chat/ComposerOverlaySurface";
import { SlashCommandPopup } from "@/components/chat/SlashCommandPopup";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  handleSlashCommandPopupKey,
  type Command,
  type PopupState,
} from "@/components/chat/useSlashCommand";

const simulatedCommands: readonly Command[] = [
  {
    id: "notice-prototype:compact",
    name: "compact",
    description: "Simulated local compact command",
    namespace: "command",
    capabilityKind: "providerCommand",
    nativeId: "compact",
  },
  {
    id: "notice-prototype:plan",
    name: "plan",
    description: "Simulated local plan command",
    namespace: "mcode",
    capabilityKind: "mcode",
    nativeId: "plan",
  },
];

interface NoticePrototypeComposerProps {
  title: string;
  body: string;
  scenario: string;
  detailsOpen: boolean;
  dismissed: boolean;
  onDetailsChange: (open: boolean) => void;
  onRecover: () => void;
  onDismiss: () => void;
  onReopen: () => void;
}

interface SlashTrigger {
  start: number;
  end: number;
}

type NoticeOverlayProps = Omit<NoticePrototypeComposerProps, "onReopen"> & {
  anchorRect: DOMRect | null;
  isSlashOpen: boolean;
};

function sameRect(a: DOMRect, b: DOMRect): boolean {
  return a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height;
}

function getVisibleNoticeAnchor(
  anchorRect: DOMRect | null,
  isSlashOpen: boolean,
  dismissed: boolean,
  scenario: string,
  detailsOpen: boolean,
): DOMRect | null {
  if (
    !anchorRect ||
    isSlashOpen ||
    dismissed ||
    scenario === "Working" ||
    (scenario === "Configuration" && !detailsOpen)
  ) {
    return null;
  }
  return anchorRect;
}

function requiresAttention(scenario: string): boolean {
  return scenario === "Sign-in required" || scenario === "Security warning";
}

function NoticeOverlay({
  anchorRect,
  isSlashOpen,
  title,
  body,
  scenario,
  detailsOpen,
  dismissed,
  onDetailsChange,
  onRecover,
  onDismiss,
}: NoticeOverlayProps) {
  const visibleAnchor = getVisibleNoticeAnchor(
    anchorRect,
    isSlashOpen,
    dismissed,
    scenario,
    detailsOpen,
  );
  if (!visibleAnchor) {
    return null;
  }
  const detailsId = "notice-prototype-details";
  const showWarning = requiresAttention(scenario);
  const Icon = showWarning ? TriangleAlert : Info;
  return (
    <ComposerOverlaySurface
      anchorRect={visibleAnchor}
      estimatedHeight={detailsOpen ? 172 : 40}
      attached
      className="composer-provider-notice-surface overflow-y-auto"
    >
      <div className="flex min-w-0 items-center overflow-hidden rounded-t-xl hover:bg-muted/60 focus-within:bg-muted/60">
        <button
          type="button"
          aria-expanded={detailsOpen}
          aria-controls={detailsId}
          className="flex h-10 min-w-0 flex-1 items-center gap-2 px-3 text-left text-xs focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onDetailsChange(!detailsOpen)}
        >
          <Icon
            className={`size-3.5 shrink-0 ${showWarning ? "text-amber-500" : "text-muted-foreground"}`}
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
          <ChevronDown
            className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${detailsOpen ? "rotate-180" : ""}`}
            aria-hidden
          />
        </button>
        {scenario === "Sign-in required" && (
          <button
            type="button"
            className="mr-2 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onRecover}
          >
            Sign in
          </button>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Dismiss notice"
                className="mr-1 grid size-10 shrink-0 place-items-center rounded-md text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                onMouseDown={(event) => event.preventDefault()}
                onClick={onDismiss}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            }
          />
          <TooltipContent>Hide notice</TooltipContent>
        </Tooltip>
      </div>
      {detailsOpen && (
        <div id={detailsId} className="border-t border-border/60 px-3 py-2.5 text-xs">
          <p className="text-muted-foreground">{body}</p>
        </div>
      )}
    </ComposerOverlaySurface>
  );
}

/** B-only composer prototype with a local notice and simulated slash commands. */
export function NoticePrototypeComposer({
  title,
  body,
  scenario,
  detailsOpen,
  dismissed,
  onDetailsChange,
  onRecover,
  onDismiss,
  onReopen,
}: NoticePrototypeComposerProps) {
  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const slashTriggerRef = useRef<SlashTrigger | null>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [draft, setDraft] = useState("");
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const updateAnchor = useCallback(() => {
    const next = composerRef.current?.getBoundingClientRect();
    if (!next) return;
    setAnchorRect((current) => current && sameRect(current, next) ? current : next);
  }, []);

  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    updateAnchor();
    window.addEventListener("resize", updateAnchor);
    window.addEventListener("scroll", updateAnchor, true);
    const observer = new ResizeObserver(updateAnchor);
    observer.observe(composer);
    return () => {
      window.removeEventListener("resize", updateAnchor);
      window.removeEventListener("scroll", updateAnchor, true);
      observer.disconnect();
    };
  }, [updateAnchor]);

  const visibleCommands = useMemo(() => {
    const filter = slashFilter.toLowerCase();
    return simulatedCommands.filter((command) => command.name.includes(filter));
  }, [slashFilter]);
  const slashState: PopupState = !slashOpen
    ? { kind: "closed" }
    : visibleCommands.length > 0
      ? { kind: "ready", items: [...visibleCommands] }
      : { kind: "empty" };

  const dismissSlash = useCallback(() => {
    setSlashOpen(false);
    setSlashFilter("");
    slashTriggerRef.current = null;
  }, []);

  const selectSlashCommand = useCallback((command: Command) => {
    const trigger = slashTriggerRef.current;
    if (!trigger) return;
    const nextDraft = `${draft.slice(0, trigger.start)}/${command.name} ${draft.slice(trigger.end)}`;
    const nextCursor = trigger.start + command.name.length + 2;
    setDraft(nextDraft);
    dismissSlash();
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  }, [dismissSlash, draft]);

  const onDraftChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const { value, selectionStart } = event.target;
    setDraft(value);
    const beforeCursor = value.slice(0, selectionStart);
    const match = /(^|\s)(\/\S*)$/.exec(beforeCursor);
    if (!match) {
      dismissSlash();
      return;
    }
    slashTriggerRef.current = {
      start: match.index + match[1].length,
      end: selectionStart,
    };
    setSlashFilter(match[2].slice(1));
    setSelectedIndex(0);
    setSlashOpen(true);
  };

  const onPopupNavigation = useCallback((event: KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      setSelectedIndex((index) => Math.min(index + 1, visibleCommands.length - 1));
    }
    if (event.key === "ArrowUp") {
      setSelectedIndex((index) => Math.max(index - 1, 0));
    }
  }, [visibleCommands.length]);

  const onDraftKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!slashOpen) return;
    const handled = handleSlashCommandPopupKey(
      event.key,
      visibleCommands,
      selectedIndex,
      selectSlashCommand,
      dismissSlash,
      onPopupNavigation,
    );
    if (handled) event.preventDefault();
  };

  const hasIssue = scenario !== "Working";
  const reopenNotice = () => {
    dismissSlash();
    onReopen();
  };

  return (
    <>
      <NoticeOverlay
        anchorRect={anchorRect}
        isSlashOpen={slashOpen}
        title={title}
        body={body}
        scenario={scenario}
        detailsOpen={detailsOpen}
        dismissed={dismissed}
        onDetailsChange={onDetailsChange}
        onRecover={onRecover}
        onDismiss={onDismiss}
      />
      <div ref={composerRef} className="mt-3 rounded-xl border border-border bg-background p-3 shadow-sm">
        <textarea
          ref={textareaRef}
          value={draft}
          aria-label="Simulated Composer"
          placeholder="Message the agent..."
          className="min-h-16 w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          onChange={onDraftChange}
          onKeyDown={onDraftKeyDown}
        />
        <div className="flex items-center justify-between border-t border-border pt-2 text-xs text-muted-foreground">
          <span>Model · {scenario === "Model changed" ? "GPT-5" : "Auto"}</span>
          <div className="flex items-center gap-2">
            {hasIssue && (dismissed || slashOpen) && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      className="rounded-md px-1 py-0.5 text-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={reopenNotice}
                    >
                      {scenario === "Sign-in required" ? "Sign-in required" : "1 notice"}
                    </button>
                  }
                />
                <TooltipContent>Reopen notice</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
      <SlashCommandPopup
        state={slashState}
        selectedIndex={selectedIndex}
        anchorRect={slashOpen ? anchorRect : null}
        onSelect={selectSlashCommand}
        onDismiss={dismissSlash}
        onRetry={() => {}}
      />
    </>
  );
}
