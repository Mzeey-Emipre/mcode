import type { ReactNode } from "react";
import {
  CommandGroup,
  CommandItem,
  CommandList,
  CommandEmpty,
} from "@/components/ui/command";
import type { PaletteGroup } from "./CommandPalette.logic";

/** Props for CommandPaletteResults. */
interface Props {
  /** Filtered, ranked groups to render. */
  groups: PaletteGroup[];
  /** Called when the user selects an item. Receives the item's value. */
  onSelect: (value: string) => void;
  /** Optional trailing content to render after the group list (e.g. an action row). */
  footer?: ReactNode;
}

/**
 * Renders ranked palette groups using cmdk Command.Group and Command.Item.
 * Section headings use mono small-caps style per the design spec.
 */
export function CommandPaletteResults({ groups, onSelect, footer }: Props) {
  return (
    <CommandList className="max-h-80 overflow-y-auto">
      <CommandEmpty>No results found.</CommandEmpty>
      {groups.map((group) => (
        <CommandGroup
          key={group.heading}
          heading={
            <span className="px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground/70">
              {group.heading}
            </span>
          }
        >
          {group.items.map((item) => (
            <CommandItem
              key={item.value}
              value={item.value}
              keywords={item.searchTerms}
              onSelect={() => onSelect(item.value)}
              className="flex items-center gap-2 px-3 py-2 text-[13px]"
            >
              <span className="flex-1 truncate">{item.title}</span>
              {item.description && (
                <span className="ml-2 truncate font-mono text-[11px] text-muted-foreground/60">
                  {item.description}
                </span>
              )}
            </CommandItem>
          ))}
        </CommandGroup>
      ))}
      {footer}
    </CommandList>
  );
}
