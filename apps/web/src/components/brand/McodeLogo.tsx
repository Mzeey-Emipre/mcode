import { cn } from "@/lib/utils";

const LOGO_SRC = `${import.meta.env.BASE_URL}brand/mcode-layered-route-cutout.svg`;

/** Named size classes for each Mcode logo surface. */
export const MCODE_LOGO_SCALES = {
  sidebar: {
    root: "gap-1.5",
    mark: "h-9 w-9",
    wordmark: "text-sm",
  },
  landing: {
    root: "mb-10 flex-col gap-2.5",
    mark: "h-28 w-28",
    wordmark: "text-4xl",
  },
} as const;

/** Known Mcode logo variants. */
export type McodeLogoVariant = keyof typeof MCODE_LOGO_SCALES;

interface McodeLogoProps {
  readonly variant?: McodeLogoVariant;
}

/** Renders the Mcode logo mark with the app wordmark. */
export function McodeLogo({ variant = "sidebar" }: McodeLogoProps) {
  const isLanding = variant === "landing";
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
      <div
        aria-hidden="true"
        className={cn(
          "flex items-baseline gap-1 font-mono font-semibold leading-none text-foreground",
          scale.wordmark,
        )}
      >
        <span>{isLanding ? "mcode" : "Mcode"}</span>
        {isLanding && <span className="text-primary/80">_</span>}
      </div>
    </div>
  );
}
