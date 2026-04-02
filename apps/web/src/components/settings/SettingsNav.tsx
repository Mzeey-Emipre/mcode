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
                "relative flex w-full rounded-md px-2 py-1.5 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                section === item.id
                  ? "bg-accent text-foreground before:absolute before:left-0 before:top-1 before:bottom-1 before:w-0.5 before:rounded-full before:bg-primary"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
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
