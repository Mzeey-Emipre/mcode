import { SubagentIdentityGlyph } from "@/components/subagents/SubagentIdentityGlyph";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  projectChildContinuationPrototypeRoster,
  useChildContinuationPrototypeStore,
} from "@/stores/childContinuationPrototypeStore";

/** Sub-agents summary row surfaced by the real Thread Overview in DEV prototype mode. */
export function PrototypeThreadOverviewSubagents({ onOpen }: { readonly onOpen: () => void }) {
  const state = useChildContinuationPrototypeStore((current) => current);
  const roster = projectChildContinuationPrototypeRoster(state);
  const glyphRows = [...roster.active, ...roster.finished].slice(0, 4);
  const stateCopy = [
    roster.active.length > 0 ? `${roster.active.length} active` : null,
    `${roster.finished.length} done`,
  ].filter(Boolean).join(", ");

  return (
    <>
      <Separator className="my-1.5" />
      <div className="px-2 pt-1 text-xs font-medium text-muted-foreground">Subagents</div>
      <Button
        variant="ghost"
        size="sm"
        type="button"
        data-testid="thread-overview-subagents"
        onClick={() => {
          state.selectChild(null);
          onOpen();
        }}
        aria-label={`Subagents, ${roster.active.length} active, ${roster.finished.length} done`}
        className="flex h-7 w-full cursor-pointer items-center justify-start gap-2 border-transparent bg-transparent px-2 text-left text-muted-foreground hover:bg-muted/40 hover:text-foreground dark:hover:bg-muted/40"
      >
        <span className="flex -space-x-1" aria-hidden>
          {glyphRows.map((row) => (
            <SubagentIdentityGlyph
              key={row.id}
              identity={row.identity}
              hasExplicitIdentity
              size={11}
              className="size-4 ring-2 ring-background"
            />
          ))}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{stateCopy}</span>
      </Button>
    </>
  );
}
