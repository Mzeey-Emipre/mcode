import { cn } from "@/lib/utils";

const LOGO_SRC = `${import.meta.env.BASE_URL}brand/mcode-layered-route-cutout.svg`;

/** Named size classes for each Mcode logo surface. */
export const MCODE_LOGO_SCALES = {
  sidebar: {
    root: "gap-1.5",
    mark: "h-9 w-9",
    wordmark: "text-sm",
  },
  newThread: {
    root: "",
    mark: "h-12 w-12 opacity-45",
    wordmark: "text-sm",
  },
} as const;

/** Known Mcode logo variants. */
export type McodeLogoVariant = keyof typeof MCODE_LOGO_SCALES;

interface McodeLogoProps {
  readonly variant?: McodeLogoVariant;
  /** Hide the wordmark when the logo acts as a quiet screen marker. */
  readonly markOnly?: boolean;
}

/** Renders the Mcode logo mark with the app wordmark. */
export function McodeLogo({ variant = "sidebar", markOnly = false }: McodeLogoProps) {
  const scale = MCODE_LOGO_SCALES[variant];

  return (
    <div
      className={cn(
        "flex select-none items-center",
        scale.root,
      )}
    >
      <img
        src={LOGO_SRC}
        alt="Mcode"
        draggable={false}
        className={cn(
          "shrink-0 object-contain",
          scale.mark,
        )}
      />
      {!markOnly && (
        <div
          aria-hidden="true"
          className={cn(
            "flex items-baseline gap-1 font-mono font-semibold leading-none text-foreground",
            scale.wordmark,
          )}
        >
          <span>Mcode</span>
        </div>
      )}
    </div>
  );
}
