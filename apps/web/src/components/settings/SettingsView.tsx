import { SECTION_MAP, type SettingsSection } from "./settings-nav";
import { PRIMARY_CONTENT_RAIL_CLASS } from "@/lib/layout-rails";
import { cn } from "@/lib/utils";

interface SettingsViewProps {
  /** Active settings section to render. */
  section: SettingsSection;
}

/**
 * Settings content panel. Renders the active section inside a centered column.
 * Navigation and header are handled by the Sidebar.
 */
export function SettingsView({ section }: SettingsViewProps) {
  const ActiveSection = SECTION_MAP[section];

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className={cn(PRIMARY_CONTENT_RAIL_CLASS, "px-4 py-6 sm:px-8 sm:py-8")}>
        <ActiveSection />
      </div>
    </div>
  );
}
