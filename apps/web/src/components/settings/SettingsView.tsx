import { SECTION_MAP, type SettingsSection } from "./settings-nav";

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
      <div className="mx-auto max-w-4xl px-8 py-8">
        <ActiveSection />
      </div>
    </div>
  );
}
