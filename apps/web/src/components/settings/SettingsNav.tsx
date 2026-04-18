import { cn } from "@/lib/utils";
import { NAV_GROUPS, type SettingsSection } from "./settings-nav";

interface SettingsNavProps {
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
}

/** Settings category navigation rendered inside the app sidebar. */
export function SettingsNav({ section, onSection }: SettingsNavProps) {
  return (
    <div className="py-4">
      {NAV_GROUPS.map((group) => (
        <div key={group.label} className="mb-5 px-2">
          <p className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
            {group.label}
          </p>
          {group.items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onSection(item.id)}
              className={cn(
                "flex w-full rounded px-3 py-1.5 text-left text-sm font-medium transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
                section === item.id
                  ? "bg-primary/10 text-foreground font-semibold"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/40",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
