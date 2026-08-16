import { cn } from "@/lib/utils";

/** Props for PathLabel. */
interface Props {
  /** The full filesystem path to display. */
  path: string;
  /** Home directory prefix to collapse to ~ (e.g. "/Users/cj"). */
  home?: string;
  /** Additional className for the wrapping span. */
  className?: string;
}

/**
 * Displays a filesystem path in mono style with left-truncation.
 * Collapses the home directory prefix to ~.
 * Uses CSS direction:rtl trick so ellipsis appears on the left while
 * the text remains logically left-to-right for screen readers.
 */
export function PathLabel({ path, home, className }: Props) {
  // Match home + either separator so Windows paths (C:\Users\cj\...) collapse
  // to "~\..." just like POSIX paths collapse to "~/...". An exact match (path
  // === home) also collapses to a bare "~".
  let display = path;
  if (home) {
    if (path === home) {
      display = "~";
    } else if (path.startsWith(home + "/") || path.startsWith(home + "\\")) {
      display = "~" + path.slice(home.length);
    }
  }

  return (
    <span
      className={cn(
        "block min-w-0 truncate font-mono text-[11.5px] text-muted-foreground/70 tabular-nums",
        className,
      )}
      style={{ direction: "rtl", unicodeBidi: "plaintext", textAlign: "left" }}
      title={path}
    >
      {display}
    </span>
  );
}
