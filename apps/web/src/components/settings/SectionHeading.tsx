/** Section heading rendered at the top of each settings panel. */
export function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/50">
      {children}
    </h2>
  );
}
