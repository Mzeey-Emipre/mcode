import { useId, type ReactNode } from "react";

/** Props for a visually grouped set of related settings. */
export interface SettingsGroupProps {
  /** Heading that identifies the settings group. */
  title: string;
  /** Short explanation of what the group controls. */
  description?: string;
  /** Setting rows rendered inside the group surface. */
  children: ReactNode;
}

/** Renders a labeled settings group on a quiet tonal surface. */
export function SettingsGroup({
  title,
  description,
  children,
}: SettingsGroupProps) {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId}>
      <div className="mb-3 px-1">
        <h2
          id={headingId}
          className="text-base font-semibold tracking-tight text-foreground"
        >
          {title}
        </h2>
        {description && (
          <p className="mt-1 max-w-[65ch] text-xs leading-5 text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      <div className="overflow-hidden rounded-xl border border-border/55 bg-card/30 px-4">
        {children}
      </div>
    </section>
  );
}
