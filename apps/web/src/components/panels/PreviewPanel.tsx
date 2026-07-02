import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Globe,
  GripVertical,
  Link2,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import type {
  PreviewAnnotationVisualProposal,
  PreviewPageStatus,
} from "@mcode/contracts";
import type { PreviewAnnotationSnapshotRequest } from "@/transport/desktop-bridge";
import { cn } from "@/lib/utils";
import { useDiffStore } from "@/stores/diffStore";
import { usePreviewDesignModeStore } from "@/stores/previewDesignModeStore";
import { usePreviewFocusStore } from "@/stores/previewFocusStore";
import { usePreviewTabsStore } from "@/stores/previewTabsStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { BrowserHeader } from "./BrowserHeader";
import { PreviewAnnotationHeader } from "./PreviewAnnotationHeader";
import { LocalPortsEmptyState } from "./LocalPortsEmptyState";
import { PreviewErrorPanel } from "./PreviewErrorPanel";
import { PreviewPerfHud } from "./PreviewPerfHud";
import { PreviewWebview, type PreviewWebviewHandle } from "./PreviewWebview";
import { formatNavError, usePreviewBridge } from "./hooks/usePreviewBridge";
import {
  usePreviewCapture,
  type PreviewCaptureKind,
} from "./hooks/usePreviewCapture";
import { usePreviewTabs } from "./hooks/usePreviewTabs";
import {
  normalizePreviewPageIdentity,
  type PreviewDraftAnnotation,
  type SavedPreviewAnnotation,
  usePreviewAnnotationStore,
} from "@/stores/previewAnnotationStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** Human-readable label for the capture confirmation badge. */
const CAPTURE_KIND_LABEL: Record<PreviewCaptureKind, string> = {
  viewport: "screenshot",
  region: "region",
  element: "element",
  context: "page context",
};

/** How long the capture confirmation badge stays visible after a successful attach. */
const CAPTURE_CONFIRMATION_DURATION_MS = 2200;
const ANNOTATION_BUBBLE_MAX_WIDTH_PX = 336;
const ANNOTATION_BUBBLE_MARGIN_PX = 8;

type VisualProposalKey = keyof PreviewAnnotationVisualProposal;
type ColorVisualProposalKey = Extract<
  VisualProposalKey,
  "textColor" | "background" | "borderColor"
>;
type ColorFormat = "rgb" | "hsl" | "hex";
type VisualLinkPairId =
  | "size"
  | "padding:block"
  | "padding:inline"
  | "margin:block"
  | "margin:inline"
  | "border:block"
  | "border:inline"
  | "radius:top"
  | "radius:bottom";

const VISUAL_CONTROL_FIELDS = [
  ["textColor", "Text color"],
  ["background", "Background"],
  ["opacity", "Opacity"],
  ["font", "Font"],
  ["fontSize", "Font size"],
  ["fontWeight", "Font weight"],
  ["borderColor", "Border color"],
] as const satisfies readonly (readonly [VisualProposalKey, string])[];

const BOX_SIDE_ORDER = [
  ["top", "T"],
  ["bottom", "B"],
  ["left", "L"],
  ["right", "R"],
] as const;

type BoxSide = (typeof BOX_SIDE_ORDER)[number][0];

const RADIUS_CORNER_ORDER = [
  ["topLeft", "TL", "Top left"],
  ["topRight", "TR", "Top right"],
  ["bottomLeft", "BL", "Bottom left"],
  ["bottomRight", "BR", "Bottom right"],
] as const;

type RadiusCorner = (typeof RADIUS_CORNER_ORDER)[number][0];

const BOX_CONTROL_GROUPS = [
  {
    id: "padding",
    label: "Padding",
    shorthand: "padding",
    keys: {
      top: "paddingTop",
      bottom: "paddingBottom",
      left: "paddingLeft",
      right: "paddingRight",
    },
  },
  {
    id: "margin",
    label: "Margin",
    shorthand: "margin",
    keys: {
      top: "marginTop",
      bottom: "marginBottom",
      left: "marginLeft",
      right: "marginRight",
    },
  },
  {
    id: "border",
    label: "Border",
    shorthand: "borderWidth",
    keys: {
      top: "borderTopWidth",
      bottom: "borderBottomWidth",
      left: "borderLeftWidth",
      right: "borderRightWidth",
    },
  },
] as const satisfies readonly {
  readonly id: "padding" | "margin" | "border";
  readonly label: string;
  readonly shorthand: VisualProposalKey;
  readonly keys: Record<BoxSide, VisualProposalKey>;
}[];
type BoxControlGroup = (typeof BOX_CONTROL_GROUPS)[number];

const RADIUS_CONTROL_GROUP = {
  id: "radius",
  label: "Radius",
  shorthand: "borderRadius",
  keys: {
    topLeft: "borderTopLeftRadius",
    topRight: "borderTopRightRadius",
    bottomLeft: "borderBottomLeftRadius",
    bottomRight: "borderBottomRightRadius",
  },
} as const satisfies {
  readonly id: "radius";
  readonly label: string;
  readonly shorthand: VisualProposalKey;
  readonly keys: Record<RadiusCorner, VisualProposalKey>;
};
type RadiusControlGroup = typeof RADIUS_CONTROL_GROUP;
type ExpandableVisualGroupId = BoxControlGroup["id"] | RadiusControlGroup["id"];

const VISUAL_LINK_PAIRS = [
  { id: "size", keys: ["width", "height"] },
  { id: "padding:block", keys: ["paddingTop", "paddingBottom"] },
  { id: "padding:inline", keys: ["paddingLeft", "paddingRight"] },
  { id: "margin:block", keys: ["marginTop", "marginBottom"] },
  { id: "margin:inline", keys: ["marginLeft", "marginRight"] },
  { id: "border:block", keys: ["borderTopWidth", "borderBottomWidth"] },
  { id: "border:inline", keys: ["borderLeftWidth", "borderRightWidth"] },
  { id: "radius:top", keys: ["borderTopLeftRadius", "borderTopRightRadius"] },
  {
    id: "radius:bottom",
    keys: ["borderBottomLeftRadius", "borderBottomRightRadius"],
  },
] as const satisfies readonly {
  readonly id: VisualLinkPairId;
  readonly keys: readonly [VisualProposalKey, VisualProposalKey];
}[];

const VISUAL_PROPOSAL_KEYS = [
  "textColor",
  "background",
  "opacity",
  "font",
  "fontSize",
  "fontWeight",
  "borderRadius",
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomRightRadius",
  "borderBottomLeftRadius",
  "borderColor",
  "width",
  "height",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
] as const satisfies readonly VisualProposalKey[];

const COLOR_CONTROL_DEFAULTS: Partial<Record<VisualProposalKey, string>> = {
  textColor: "rgb(10, 52, 92)",
  background: "rgba(0, 0, 0, 0)",
  borderColor: "rgb(10, 52, 92)",
};

const PIXEL_CONTROL_FIELDS = new Set<VisualProposalKey>([
  "fontSize",
  "borderRadius",
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomRightRadius",
  "borderBottomLeftRadius",
  "width",
  "height",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
]);

const EMPTY_SAVED_ANNOTATIONS: SavedPreviewAnnotation[] = [];

function hasVisualProposal(
  value: PreviewAnnotationVisualProposal | undefined,
): boolean {
  if (!value) return false;
  return Object.values(value).some((entry) =>
    typeof entry === "number"
      ? Number.isFinite(entry)
      : Boolean(String(entry ?? "").trim()),
  );
}

function cleanVisualProposal(
  value: PreviewAnnotationVisualProposal,
  baseline?: PreviewDraftAnnotation["elementStyle"],
): PreviewAnnotationVisualProposal | undefined {
  const next: Record<string, string | number> = {};
  for (const key of VISUAL_PROPOSAL_KEYS) {
    const normalized = normalizeVisualControlValue(key, value[key]);
    if (normalized === undefined) continue;
    const baselineValue = normalizeVisualControlValue(
      key,
      baselineVisualControlValue(key, baseline),
    );
    if (normalized === baselineValue) continue;
    next[key] = normalized;
  }
  return Object.keys(next).length > 0
    ? (next as PreviewAnnotationVisualProposal)
    : undefined;
}

function normalizeVisualControlValue(
  key: VisualProposalKey,
  value: unknown,
): string | number | undefined {
  if (key === "opacity") {
    if (String(value ?? "").trim() === "") return undefined;
    const numeric =
      typeof value === "number" ? value : Number(String(value ?? "").trim());
    return Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : undefined;
  }
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed : undefined;
}

function parseCssBoxValue(value: unknown): Record<BoxSide, string> | undefined {
  const parts = String(value ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  const top = parts[0];
  const right = parts[1] ?? top;
  const bottom = parts[2] ?? top;
  const left = parts[3] ?? right;
  return { left, top, right, bottom };
}

function parseCssRadiusValue(
  value: unknown,
): Record<RadiusCorner, string> | undefined {
  const radiusText = String(value ?? "").split("/")[0]?.trim() ?? "";
  const parts = radiusText.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  const topLeft = parts[0];
  const topRight = parts[1] ?? topLeft;
  const bottomRight = parts[2] ?? topLeft;
  const bottomLeft = parts[3] ?? topRight;
  return { topLeft, topRight, bottomRight, bottomLeft };
}

function boxGroupForKey(
  key: VisualProposalKey,
): (typeof BOX_CONTROL_GROUPS)[number] | undefined {
  return BOX_CONTROL_GROUPS.find((group) =>
    BOX_SIDE_ORDER.some(([side]) => group.keys[side] === key),
  );
}

function radiusCornerForKey(key: VisualProposalKey): RadiusCorner | undefined {
  for (const [corner] of RADIUS_CORNER_ORDER) {
    if (RADIUS_CONTROL_GROUP.keys[corner] === key) return corner;
  }
  return undefined;
}

function boxSideForKey(key: VisualProposalKey): BoxSide | undefined {
  for (const [side] of BOX_SIDE_ORDER) {
    if (BOX_CONTROL_GROUPS.some((group) => group.keys[side] === key)) {
      return side;
    }
  }
  return undefined;
}

function baselineVisualControlValue(
  key: VisualProposalKey,
  baseline?: PreviewDraftAnnotation["elementStyle"],
): unknown {
  if (!baseline) return undefined;
  const direct = baseline[key];
  if (direct !== undefined) return direct;
  const group = boxGroupForKey(key);
  const side = boxSideForKey(key);
  if (group && side) return parseCssBoxValue(baseline[group.shorthand])?.[side];
  const corner = radiusCornerForKey(key);
  if (!corner) return undefined;
  return parseCssRadiusValue(baseline[RADIUS_CONTROL_GROUP.shorthand])?.[corner];
}

function expandVisualShorthands(
  value: PreviewAnnotationVisualProposal | PreviewDraftAnnotation["elementStyle"] | undefined,
): PreviewAnnotationVisualProposal {
  const next: PreviewAnnotationVisualProposal = {};
  if (!value) return next;
  for (const group of BOX_CONTROL_GROUPS) {
    const parsed = parseCssBoxValue(value[group.shorthand]);
    if (!parsed) continue;
    for (const [side] of BOX_SIDE_ORDER) {
      const key = group.keys[side];
      if (value[key] === undefined) next[key] = parsed[side];
    }
  }
  const parsedRadius = parseCssRadiusValue(value[RADIUS_CONTROL_GROUP.shorthand]);
  if (parsedRadius) {
    for (const [corner] of RADIUS_CORNER_ORDER) {
      const key = RADIUS_CONTROL_GROUP.keys[corner];
      if (value[key] === undefined) next[key] = parsedRadius[corner];
    }
  }
  return next;
}

function initialVisualControls(
  elementStyle: PreviewDraftAnnotation["elementStyle"],
  proposedChanges: PreviewAnnotationVisualProposal | undefined,
): PreviewAnnotationVisualProposal {
  return {
    ...(elementStyle ?? {}),
    ...expandVisualShorthands(elementStyle),
    ...(proposedChanges ?? {}),
    ...expandVisualShorthands(proposedChanges),
  };
}

function parseCssPx(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  const match = text.match(/^-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const numeric = Number(match[0]);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function displayVisualControlValue(
  key: VisualProposalKey,
  value: unknown,
): string {
  if (value === undefined || value === null) return "";
  const text = String(value);
  if (!PIXEL_CONTROL_FIELDS.has(key)) return text;
  const match = text.trim().match(/^(-?\d+(?:\.\d+)?)px$/i);
  return match?.[1] ?? text;
}

function encodeVisualControlValue(
  key: VisualProposalKey,
  rawValue: string,
): string | number {
  const trimmed = rawValue.trim();
  if (key === "opacity") return trimmed;
  if (!PIXEL_CONTROL_FIELDS.has(key) || !trimmed) return rawValue;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return `${trimmed}px`;
  return rawValue;
}

function proposalSideDeltaPx(
  value: PreviewAnnotationVisualProposal | undefined,
  baseline: PreviewDraftAnnotation["elementStyle"] | undefined,
  group: (typeof BOX_CONTROL_GROUPS)[number],
  side: BoxSide,
): number {
  if (!value) return 0;
  const key = group.keys[side];
  const direct = parseCssPx(value[key]);
  const shorthand = parseCssBoxValue(value[group.shorthand])?.[side];
  const next = direct ?? parseCssPx(shorthand);
  if (next === undefined) return 0;
  const baselineValue = parseCssPx(baselineVisualControlValue(key, baseline)) ?? 0;
  return next - baselineValue;
}

function visualProposalBounds(
  bounds: PreviewDraftAnnotation["bounds"],
  value: PreviewAnnotationVisualProposal | undefined,
  baseline?: PreviewDraftAnnotation["elementStyle"],
): PreviewDraftAnnotation["bounds"] {
  if (!value) return bounds;
  const padding = BOX_CONTROL_GROUPS[0];
  const margin = BOX_CONTROL_GROUPS[1];
  const border = BOX_CONTROL_GROUPS[2];
  const leftGrow =
    proposalSideDeltaPx(value, baseline, margin, "left") +
    proposalSideDeltaPx(value, baseline, padding, "left") +
    proposalSideDeltaPx(value, baseline, border, "left");
  const topGrow =
    proposalSideDeltaPx(value, baseline, margin, "top") +
    proposalSideDeltaPx(value, baseline, padding, "top") +
    proposalSideDeltaPx(value, baseline, border, "top");
  const rightGrow =
    proposalSideDeltaPx(value, baseline, margin, "right") +
    proposalSideDeltaPx(value, baseline, padding, "right") +
    proposalSideDeltaPx(value, baseline, border, "right");
  const bottomGrow =
    proposalSideDeltaPx(value, baseline, margin, "bottom") +
    proposalSideDeltaPx(value, baseline, padding, "bottom") +
    proposalSideDeltaPx(value, baseline, border, "bottom");
  return {
    x: bounds.x - leftGrow,
    y: bounds.y - topGrow,
    width:
      Math.max(1, parseCssPx(value.width) ?? bounds.width) +
      leftGrow +
      rightGrow,
    height:
      Math.max(1, parseCssPx(value.height) ?? bounds.height) +
      topGrow +
      bottomGrow,
  };
}

function visualProposalGeometryStyle(
  bounds: PreviewDraftAnnotation["bounds"],
  value: PreviewAnnotationVisualProposal | undefined,
  baseline?: PreviewDraftAnnotation["elementStyle"],
): CSSProperties {
  const proposedBounds = visualProposalBounds(bounds, value, baseline);
  return {
    left: proposedBounds.x,
    top: proposedBounds.y,
    width: proposedBounds.width,
    height: proposedBounds.height,
  };
}

function visualOverlayStyle(
  value: PreviewAnnotationVisualProposal | undefined,
): CSSProperties {
  if (!value) return {};
  const hasBorderWidth = BOX_SIDE_ORDER.some(([side]) =>
    Boolean(value[BOX_CONTROL_GROUPS[2].keys[side]]),
  );
  const normalizedOpacity = normalizeVisualControlValue("opacity", value.opacity);
  return {
    color: value.textColor,
    background: value.background,
    opacity:
      typeof normalizedOpacity === "number" ? normalizedOpacity : undefined,
    fontFamily: value.font,
    fontSize: value.fontSize,
    fontWeight: value.fontWeight,
    borderRadius: value.borderRadius,
    borderTopLeftRadius: value.borderTopLeftRadius,
    borderTopRightRadius: value.borderTopRightRadius,
    borderBottomRightRadius: value.borderBottomRightRadius,
    borderBottomLeftRadius: value.borderBottomLeftRadius,
    borderColor: value.borderColor,
    borderWidth: value.borderWidth,
    borderTopWidth: value.borderTopWidth,
    borderRightWidth: value.borderRightWidth,
    borderBottomWidth: value.borderBottomWidth,
    borderLeftWidth: value.borderLeftWidth,
    borderStyle: value.borderColor || value.borderWidth || hasBorderWidth
      ? "solid"
      : undefined,
    boxSizing: "border-box",
  };
}

function visualControlAffordance(
  key: VisualProposalKey,
): "swatch" | "px" | "0-1" | undefined {
  if (key in COLOR_CONTROL_DEFAULTS) return "swatch";
  if (key === "opacity") return "0-1";
  if (PIXEL_CONTROL_FIELDS.has(key)) return "px";
  return undefined;
}

interface RgbaColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a?: number;
}

function clampColorChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function componentToHex(value: number): string {
  return clampColorChannel(value).toString(16).padStart(2, "0").toUpperCase();
}

function colorToHex(color: RgbaColor): string {
  return `#${componentToHex(color.r)}${componentToHex(color.g)}${componentToHex(color.b)}`;
}

function rgbToHsl(color: RgbaColor): { h: number; s: number; l: number } {
  const r = clampColorChannel(color.r) / 255;
  const g = clampColorChannel(color.g) / 255;
  const b = clampColorChannel(color.b) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const delta = max - min;
  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / delta + (g < b ? 6 : 0);
  if (max === g) h = (b - r) / delta + 2;
  if (max === b) h = (r - g) / delta + 4;
  return { h: h * 60, s, l };
}

function hueToRgb(p: number, q: number, t: number): number {
  let next = t;
  if (next < 0) next += 1;
  if (next > 1) next -= 1;
  if (next < 1 / 6) return p + (q - p) * 6 * next;
  if (next < 1 / 2) return q;
  if (next < 2 / 3) return p + (q - p) * (2 / 3 - next) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number, a?: number): RgbaColor {
  const hue = (((h % 360) + 360) % 360) / 360;
  const sat = clampUnit(s);
  const light = clampUnit(l);
  if (sat === 0) {
    const gray = clampColorChannel(light * 255);
    return { r: gray, g: gray, b: gray, ...(a !== undefined ? { a } : {}) };
  }
  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;
  return {
    r: clampColorChannel(hueToRgb(p, q, hue + 1 / 3) * 255),
    g: clampColorChannel(hueToRgb(p, q, hue) * 255),
    b: clampColorChannel(hueToRgb(p, q, hue - 1 / 3) * 255),
    ...(a !== undefined ? { a } : {}),
  };
}

function parseColorValue(value: unknown): RgbaColor | undefined {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  const hex = text.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const raw = hex[1]!;
    const full =
      raw.length === 3
        ? raw
            .split("")
            .map((part) => part + part)
            .join("")
        : raw;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
    };
  }
  const rgb = text.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i,
  );
  if (rgb) {
    return {
      r: clampColorChannel(Number(rgb[1])),
      g: clampColorChannel(Number(rgb[2])),
      b: clampColorChannel(Number(rgb[3])),
      ...(rgb[4] !== undefined ? { a: clampUnit(Number(rgb[4])) } : {}),
    };
  }
  const hsl = text.match(
    /^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%(?:\s*,\s*([\d.]+))?\s*\)$/i,
  );
  if (hsl) {
    return hslToRgb(
      Number(hsl[1]),
      Number(hsl[2]) / 100,
      Number(hsl[3]) / 100,
      hsl[4] !== undefined ? clampUnit(Number(hsl[4])) : undefined,
    );
  }
  return undefined;
}

function detectColorFormat(value: unknown): ColorFormat {
  const text = String(value ?? "").trim();
  if (/^#?[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(text)) return "hex";
  if (/^hsla?\(/i.test(text)) return "hsl";
  return "rgb";
}

function formatColorValue(color: RgbaColor, format: ColorFormat): string {
  const alpha = color.a !== undefined && color.a < 1 ? clampUnit(color.a) : undefined;
  if (format === "hex") return colorToHex(color);
  if (format === "hsl") {
    const hsl = rgbToHsl(color);
    const base = `${Math.round(hsl.h)}, ${Math.round(hsl.s * 100)}%, ${Math.round(hsl.l * 100)}%`;
    return alpha !== undefined ? `hsla(${base}, ${alpha})` : `hsl(${base})`;
  }
  const base = `${clampColorChannel(color.r)}, ${clampColorChannel(color.g)}, ${clampColorChannel(color.b)}`;
  return alpha !== undefined ? `rgba(${base}, ${alpha})` : `rgb(${base})`;
}

function colorEditableSelectionRange(
  value: string,
): readonly [number, number] | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith("#")) return [1, trimmed.length];
  const open = trimmed.indexOf("(");
  const close = trimmed.lastIndexOf(")");
  if (open >= 0 && close > open) return [open + 1, close];
  return undefined;
}

function colorSwatchValue(
  key: VisualProposalKey,
  value: unknown,
): string | undefined {
  if (!(key in COLOR_CONTROL_DEFAULTS)) return undefined;
  const parsed = parseColorValue(value);
  if (parsed) return formatColorValue(parsed, "rgb");
  return COLOR_CONTROL_DEFAULTS[key];
}

function linkedPairActiveClass(active: boolean): string {
  return active
    ? "border-sky-400/40 bg-sky-400/15 text-sky-300"
    : "border-white/10 bg-[#202020] text-neutral-500 hover:text-neutral-200";
}

function VisualLinkButton({
  active,
  label,
  onClick,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "size-5 rounded-full border p-0 hover:bg-white/10",
        linkedPairActiveClass(active),
      )}
      onClick={onClick}
    >
      <Link2 size={11} aria-hidden />
    </Button>
  );
}

function InspectorValueInput({
  controlKey,
  label,
  value,
  onChange,
  className,
}: {
  readonly controlKey: VisualProposalKey;
  readonly label: string;
  readonly value: unknown;
  readonly onChange: (key: VisualProposalKey, value: string | number) => void;
  readonly className?: string;
}) {
  const affordance = visualControlAffordance(controlKey);
  return (
    <span className="relative flex min-w-0 items-center">
      <Input
        size="xs"
        aria-label={label}
        value={displayVisualControlValue(controlKey, value)}
        onChange={(event) => onChange(controlKey, event.target.value)}
        placeholder={affordance === "0-1" ? "0-1" : undefined}
        inputMode={affordance === "0-1" || affordance === "px" ? "decimal" : undefined}
        className={cn(
          "h-7 rounded-[0.65rem] border-white/10 bg-[#303030] text-xs text-neutral-100 shadow-none placeholder:text-neutral-500 focus-visible:ring-white/20",
          affordance === "px" && "pr-8",
          className,
        )}
      />
      {affordance === "px" ? (
        <span className="pointer-events-none absolute right-2 text-xs text-neutral-400">
          px
        </span>
      ) : null}
    </span>
  );
}

function InspectorRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-2 text-xs text-neutral-300">
      <span>{label}</span>
      {children}
    </div>
  );
}

function ColorInspectorControl({
  colorFormat,
  controlKey,
  label,
  value,
  onChange,
  onFormatChange,
}: {
  readonly colorFormat: ColorFormat;
  readonly controlKey: ColorVisualProposalKey;
  readonly label: string;
  readonly value: unknown;
  readonly onChange: (key: VisualProposalKey, value: string | number) => void;
  readonly onFormatChange: (key: ColorVisualProposalKey, format: ColorFormat) => void;
}) {
  const parsed = parseColorValue(value);
  const fallback = parseColorValue(COLOR_CONTROL_DEFAULTS[controlKey]) ?? {
    r: 0,
    g: 0,
    b: 0,
  };
  const pickerColor = parsed ?? fallback;
  const swatch = colorSwatchValue(controlKey, value);
  const displayValue = String(value ?? "");
  return (
    <InspectorRow label={label}>
      <div className="relative flex min-w-0 items-center">
        <Popover>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Open ${label} picker`}
                className="absolute left-2 z-10 size-4 rounded-full border border-white/20 p-0 shadow-sm hover:ring-2 hover:ring-white/20"
                style={{ background: swatch }}
              />
            }
          />
          <PopoverContent
            side="bottom"
            align="start"
            sideOffset={6}
            collisionPadding={8}
            data-preview-design-keep-open="true"
            className="w-64 rounded-lg border-white/10 bg-[#303030] p-2.5 text-neutral-100 shadow-2xl"
          >
            <div className="space-y-2.5">
              <Input
                type="color"
                aria-label={`Color picker for ${label}`}
                value={colorToHex(pickerColor)}
                onChange={(event) => {
                  const next = parseColorValue(event.target.value);
                  if (!next) return;
                  onChange(controlKey, formatColorValue(next, colorFormat));
                }}
                className="h-24 w-full rounded-md border-white/10 bg-[#252525] p-1"
              />
              <div className="grid grid-cols-3 overflow-hidden rounded-md border border-white/10 bg-[#252525]">
                {(["rgb", "hsl", "hex"] as const).map((format) => (
                  <Button
                    key={format}
                    type="button"
                    variant="ghost"
                    size="xs"
                    aria-label={`Use ${format.toUpperCase()} for ${label}`}
                    aria-pressed={colorFormat === format}
                    className={cn(
                      "h-7 rounded-none border-r border-white/10 text-xs uppercase last:border-r-0",
                      colorFormat === format
                        ? "bg-white/12 text-white"
                        : "text-neutral-400 hover:bg-white/8 hover:text-white",
                    )}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      onFormatChange(controlKey, format);
                    }}
                  >
                    {format}
                  </Button>
                ))}
              </div>
            </div>
          </PopoverContent>
        </Popover>
        <Input
          size="xs"
          aria-label={label}
          value={displayValue}
          onFocus={(event) => {
            const range = colorEditableSelectionRange(event.currentTarget.value);
            if (!range) return;
            window.setTimeout(() => {
              event.currentTarget.setSelectionRange(range[0], range[1]);
            }, 0);
          }}
          onChange={(event) => onChange(controlKey, event.target.value)}
          className="h-7 rounded-[0.65rem] border-white/10 bg-[#303030] pl-8 font-mono text-xs text-neutral-100 placeholder:text-neutral-500 focus-visible:ring-sky-400/50"
        />
      </div>
    </InspectorRow>
  );
}

function LinkedSizeControls({
  linked,
  onChange,
  onToggleLinked,
  values,
}: {
  readonly linked: boolean;
  readonly onChange: (key: VisualProposalKey, value: string | number) => void;
  readonly onToggleLinked: () => void;
  readonly values: PreviewAnnotationVisualProposal;
}) {
  return (
    <div className="grid grid-cols-[5.5rem_1.75rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1 text-xs text-neutral-300">
      <span>Width</span>
      <div className="row-span-2 flex items-center justify-center">
        <VisualLinkButton
          active={linked}
          label="Link width and height"
          onClick={onToggleLinked}
        />
      </div>
      <InspectorValueInput
        controlKey="width"
        label="Width"
        value={values.width}
        onChange={onChange}
      />
      <span>Height</span>
      <InspectorValueInput
        controlKey="height"
        label="Height"
        value={values.height}
        onChange={onChange}
      />
    </div>
  );
}

function QuadInputStrip({
  entries,
  onChange,
  values,
}: {
  readonly entries: readonly {
    readonly key: VisualProposalKey;
    readonly ariaLabel: string;
    readonly label: string;
    readonly shortLabel: string;
  }[];
  readonly onChange: (key: VisualProposalKey, value: string | number) => void;
  readonly values: PreviewAnnotationVisualProposal;
}) {
  return (
    <div className="grid min-w-0 grid-cols-4 overflow-hidden rounded-[0.65rem] border border-white/10 bg-[#2d2d2d]">
      {entries.map((entry) => (
        <label
          key={entry.key}
          className="relative min-w-0 border-r border-white/10 last:border-r-0"
        >
          <span className="sr-only">{entry.ariaLabel}</span>
          <Input
            size="xs"
            aria-label={entry.ariaLabel}
            value={displayVisualControlValue(entry.key, values[entry.key])}
            onChange={(event) => onChange(entry.key, event.target.value)}
            inputMode="decimal"
            className="h-7 rounded-none border-0 bg-transparent px-0 text-center font-mono text-xs tabular-nums text-neutral-100 shadow-none placeholder:text-neutral-500 focus-visible:ring-1 focus-visible:ring-sky-400/50"
          />
        </label>
      ))}
    </div>
  );
}

function ExpandableQuadGroup({
  entries,
  expanded,
  groupId,
  label,
  linkedPairs,
  linkedPairState,
  onChange,
  onToggleExpanded,
  onToggleLinked,
  values,
}: {
  readonly entries: readonly {
    readonly key: VisualProposalKey;
    readonly ariaLabel: string;
    readonly label: string;
    readonly shortLabel: string;
  }[];
  readonly expanded: boolean;
  readonly groupId: ExpandableVisualGroupId;
  readonly label: string;
  readonly linkedPairs: readonly {
    readonly id: VisualLinkPairId;
    readonly label: string;
  }[];
  readonly linkedPairState: Partial<Record<VisualLinkPairId, boolean>>;
  readonly onChange: (key: VisualProposalKey, value: string | number) => void;
  readonly onToggleExpanded: (groupId: ExpandableVisualGroupId) => void;
  readonly onToggleLinked: (pairId: VisualLinkPairId) => void;
  readonly values: PreviewAnnotationVisualProposal;
}) {
  if (!expanded) {
    return (
      <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-2 text-xs text-neutral-300">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="h-7 justify-start gap-1 rounded-md px-0 text-xs text-neutral-300 hover:bg-transparent hover:text-white"
          aria-expanded={false}
          onClick={() => onToggleExpanded(groupId)}
        >
          <ChevronRight size={13} aria-hidden />
          {label}
        </Button>
        <QuadInputStrip entries={entries} values={values} onChange={onChange} />
      </div>
    );
  }

  const [firstPair, secondPair] = linkedPairs;
  return (
    <div className="space-y-1.5 border-t border-white/8 pt-2 text-xs text-neutral-300 first:border-t-0 first:pt-0">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="h-6 justify-start gap-1 rounded-md px-0 text-xs text-neutral-300 hover:bg-transparent hover:text-white"
        aria-expanded
        onClick={() => onToggleExpanded(groupId)}
      >
        <ChevronDown size={13} aria-hidden />
        {label}
      </Button>
      <div className="grid grid-cols-[5.5rem_1.75rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
        {entries.map((entry, index) => {
          const link =
            index === 0 && firstPair
              ? firstPair
              : index === 2 && secondPair
                ? secondPair
                : undefined;
          return (
            <Fragment key={entry.key}>
              <span>{entry.label}</span>
              <div className="flex items-center justify-center">
                {link ? (
                  <VisualLinkButton
                    active={Boolean(linkedPairState[link.id])}
                    label={link.label}
                    onClick={() => onToggleLinked(link.id)}
                  />
                ) : null}
              </div>
              <InspectorValueInput
                controlKey={entry.key}
                label={entry.ariaLabel}
                value={values[entry.key]}
                onChange={onChange}
              />
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function boxGroupEntries(group: BoxControlGroup) {
  return BOX_SIDE_ORDER.map(([side, shortLabel]) => ({
    key: group.keys[side],
    ariaLabel: `${group.label} ${side}`,
    label: titleCase(side),
    shortLabel,
  }));
}

function radiusGroupEntries(group: RadiusControlGroup) {
  return RADIUS_CORNER_ORDER.map(([corner, shortLabel, label]) => ({
    key: group.keys[corner],
    ariaLabel: `${group.label} ${label.toLowerCase()}`,
    label,
    shortLabel,
  }));
}

function groupLinkPairs(
  groupId: ExpandableVisualGroupId,
): readonly { readonly id: VisualLinkPairId; readonly label: string }[] {
  if (groupId === "radius") {
    return [
      { id: "radius:top", label: "Link top radius corners" },
      { id: "radius:bottom", label: "Link bottom radius corners" },
    ];
  }
  return [
    { id: `${groupId}:block` as VisualLinkPairId, label: `Link ${groupId} top and bottom` },
    { id: `${groupId}:inline` as VisualLinkPairId, label: `Link ${groupId} left and right` },
  ];
}

function annotationBubbleStyle(
  bounds: PreviewDraftAnnotation["bounds"],
  surfaceWidth: number,
): CSSProperties {
  const bubbleWidth =
    surfaceWidth > 0
      ? Math.min(
          ANNOTATION_BUBBLE_MAX_WIDTH_PX,
          Math.max(0, surfaceWidth - ANNOTATION_BUBBLE_MARGIN_PX * 2),
        )
      : ANNOTATION_BUBBLE_MAX_WIDTH_PX;
  const preferredLeft = bounds.x + bounds.width + ANNOTATION_BUBBLE_MARGIN_PX;
  const maxLeft =
    surfaceWidth > 0
      ? Math.max(
          ANNOTATION_BUBBLE_MARGIN_PX,
          surfaceWidth - bubbleWidth - ANNOTATION_BUBBLE_MARGIN_PX,
        )
      : preferredLeft;

  return {
    left: Math.min(
      Math.max(ANNOTATION_BUBBLE_MARGIN_PX, preferredLeft),
      maxLeft,
    ),
    top: Math.max(ANNOTATION_BUBBLE_MARGIN_PX, bounds.y),
    maxWidth: `calc(100% - ${ANNOTATION_BUBBLE_MARGIN_PX * 2}px)`,
  };
}

function draftFromSaved(
  threadId: string,
  annotation: SavedPreviewAnnotation,
): PreviewDraftAnnotation {
  const elementStyle =
    annotation.pageContext.elementStyle ?? annotation.snapshot.capture.elementStyle;
  return {
    threadId,
    pageIdentity: annotation.pageIdentity,
    bounds: annotation.targetContext.bounds,
    selectorHint: annotation.targetContext.selectorHint,
    label: annotation.targetContext.label,
    snapshot: annotation.snapshot,
    pageContext: annotation.pageContext,
    ...(elementStyle ? { elementStyle } : {}),
    note: annotation.note ?? "",
    proposedChanges: annotation.proposedChanges,
  };
}

/** Fallback tab id used until the host tab list has loaded. */
export const PREVIEW_WEBVIEW_FALLBACK_TAB_ID =
  "__mcode_webview_active_fallback__";

/** Returns whether the flagged webview renderer should replace the native preview surface. */
export function shouldRenderWebviewPreview(
  engine: string | undefined,
): boolean {
  return engine === "webview";
}

export interface PreviewPanelProps {
  /** Thread that owns preview state (URL memory and future captures). */
  readonly threadId: string;
  /** Active workspace id; scopes spill files under the Mcode app data dir (not the project tree). */
  readonly workspaceId?: string | null;
}

/**
 * Embedded site preview: a clean URL header above a region aligned to an
 * Electron BrowserView. The header morphs across empty / focused / loaded
 * states; when nothing is loaded the surface lists detected localhost ports as
 * one-click cards. Full viewport, drag-selected region, element-pick PNGs, or
 * fence-only page context attach to the composer. A loading banner sits between
 * the header and guest region because the BrowserView stacks above HTML and
 * would hide in-surface overlays. In web-only builds without
 * `desktopBridge.preview`, renders an explanatory empty state.
 */
export function PreviewPanel({ threadId, workspaceId }: PreviewPanelProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const webviewRef = useRef<PreviewWebviewHandle | null>(null);

  const designModeActive = usePreviewDesignModeStore(
    (s) => s.modes[threadId] === true,
  );
  const designModeToggle = usePreviewDesignModeStore((s) => s.toggle);
  const designModeSetActive = usePreviewDesignModeStore((s) => s.setActive);
  const annotationSignal = usePreviewAnnotationStore(
    (s) => s.byThread[threadId]?.length ?? 0,
  );
  const draftAnnotation = usePreviewAnnotationStore((s) => s.drafts[threadId]);
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(
    null,
  );
  const [bubbleNote, setBubbleNote] = useState("");
  const [bubbleVisuals, setBubbleVisuals] =
    useState<PreviewAnnotationVisualProposal>({});
  const [bubbleAdvancedOpen, setBubbleAdvancedOpen] = useState(false);
  const [expandedVisualGroups, setExpandedVisualGroups] = useState<
    Partial<Record<ExpandableVisualGroupId, boolean>>
  >({});
  const [linkedVisualPairs, setLinkedVisualPairs] = useState<
    Partial<Record<VisualLinkPairId, boolean>>
  >({});
  const [colorFormats, setColorFormats] = useState<
    Partial<Record<ColorVisualProposalKey, ColorFormat>>
  >({});
  const [outsideWarned, setOutsideWarned] = useState(false);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const bubbleNoteInputRef = useRef<HTMLInputElement | null>(null);
  const omniboxFocusTick = usePreviewFocusStore((s) => s.omniboxFocusTick);
  const previewRenderingEngine = useSettingsStore(
    (s) => s.settings.preview.rendering.engine,
  );
  const showWebviewPreview = shouldRenderWebviewPreview(previewRenderingEngine);

  const bridge = usePreviewBridge({
    threadId,
    workspaceId,
    surfaceRef,
    forceHidden: showWebviewPreview,
  });
  const [webviewSrc, setWebviewSrc] = useState<string | null>(null);
  const webviewSrcRef = useRef<string | null>(null);
  const setTrackedWebviewSrc = useCallback((nextSrc: string | null): void => {
    webviewSrcRef.current = nextSrc;
    setWebviewSrc(nextSrc);
  }, []);
  const [webviewNavError, setWebviewNavError] = useState<string | null>(null);
  const [webviewCanBack, setWebviewCanBack] = useState(false);
  const [webviewCanFwd, setWebviewCanFwd] = useState(false);
  const [webviewPageStatus, setWebviewPageStatus] = useState<PreviewPageStatus>(
    {
      url: null,
      title: null,
      favicon: null,
      phase: "loaded",
    },
  );

  // Inline capture confirmation. The composer chip lives in another panel and
  // may scroll off; this badge acknowledges the action where the user is
  // looking. The timer ref lets a second capture reset the dismissal window
  // without leaving a stale badge behind.
  const [lastCapture, setLastCapture] = useState<PreviewCaptureKind | null>(
    null,
  );
  const captureConfirmTimerRef = useRef<number | null>(null);
  const onCaptureSuccess = useCallback((kind: PreviewCaptureKind): void => {
    setLastCapture(kind);
    if (captureConfirmTimerRef.current !== null) {
      window.clearTimeout(captureConfirmTimerRef.current);
    }
    captureConfirmTimerRef.current = window.setTimeout(() => {
      setLastCapture(null);
      captureConfirmTimerRef.current = null;
    }, CAPTURE_CONFIRMATION_DURATION_MS);
  }, []);
  useEffect(() => {
    return () => {
      if (captureConfirmTimerRef.current !== null) {
        window.clearTimeout(captureConfirmTimerRef.current);
      }
    };
  }, []);

  const capture = usePreviewCapture({
    threadId,
    pushSync: bridge.pushSync,
    onSuccess: onCaptureSuccess,
  });
  // Subscribes the scope's tab set into usePreviewTabsStore and exposes the
  // "New page" action for the header. Page switching/closing is driven from the
  // activity rail (the page switcher), so this panel no longer renders a strip.
  const tabs = usePreviewTabs(threadId);
  const activeWebviewTabId =
    tabs.tabSet?.activeTabId ?? PREVIEW_WEBVIEW_FALLBACK_TAB_ID;

  useEffect(() => {
    webviewSrcRef.current = webviewSrc;
  }, [webviewSrc]);

  useEffect(() => {
    if (!showWebviewPreview) return;
    const stored = bridge.storedUrl.trim();
    if (!stored) {
      setTrackedWebviewSrc(null);
      setWebviewPageStatus({
        url: null,
        title: null,
        favicon: null,
        phase: "loaded",
      });
      return;
    }
    if (webviewRef.current?.getUrl() === stored) return;
    if (webviewSrcRef.current === stored) return;
    setTrackedWebviewSrc(stored);
  }, [bridge.storedUrl, setTrackedWebviewSrc, showWebviewPreview, threadId]);

  const onWebviewPageStatus = useCallback(
    (status: PreviewPageStatus): void => {
      setWebviewPageStatus(status);
      if (status.url) {
        useDiffStore.getState().setPreviewUrlForThread(threadId, status.url);
      }
    },
    [threadId],
  );

  const onWebviewNavigate = useCallback(
    (url: string): void => {
      setWebviewNavError(null);
      setWebviewPageStatus((status) => ({ ...status, phase: "loading" }));
      void bridge.resolveNavigation(url).then((result) => {
        if (!result.ok) {
          setWebviewPageStatus((status) => ({ ...status, phase: "loaded" }));
          setWebviewNavError(formatNavError(result.error));
          return;
        }
        useDiffStore.getState().setPreviewUrlForThread(threadId, result.url);
        setWebviewPageStatus({
          url: result.url,
          title: null,
          favicon: null,
          phase: "loading",
        });
        const liveUrl = webviewRef.current?.getUrl();
        const mountedSrc = webviewSrcRef.current;
        if (liveUrl === result.url) {
          webviewRef.current?.reload();
          return;
        }
        if (mountedSrc === result.url) {
          webviewRef.current?.navigate(result.url);
          return;
        }
        setTrackedWebviewSrc(result.url);
      });
    },
    [bridge, setTrackedWebviewSrc, threadId],
  );

  const onWebviewOpenExternal = useCallback((): void => {
    const url = webviewRef.current?.getUrl() || webviewSrc;
    if (url) void window.desktopBridge?.openExternalUrl(url);
  }, [webviewSrc]);

  const onWebviewGetZoom = useCallback(async (): Promise<number> => {
    return (await webviewRef.current?.getZoom()) ?? 1;
  }, []);

  const onWebviewSetZoom = useCallback(
    async (factor: number): Promise<number> => {
      return (await webviewRef.current?.setZoom(factor)) ?? factor;
    },
    [],
  );

  const effectivePageStatus = showWebviewPreview
    ? webviewPageStatus
    : bridge.pageStatus;
  const effectiveInputUrl = showWebviewPreview
    ? (webviewPageStatus.url ?? webviewSrc ?? "")
    : bridge.inputUrl;
  const effectivePageTitle = showWebviewPreview
    ? webviewPageStatus.title
    : bridge.pageTitle;
  const effectiveFaviconUrl = showWebviewPreview
    ? webviewPageStatus.favicon
    : bridge.faviconUrl;
  const effectiveCanBack = showWebviewPreview ? webviewCanBack : bridge.canBack;
  const effectiveCanFwd = showWebviewPreview ? webviewCanFwd : bridge.canFwd;
  const effectivePreviewLoading = showWebviewPreview
    ? webviewPageStatus.phase === "loading"
    : bridge.previewLoading;
  const effectiveNavError = showWebviewPreview
    ? webviewNavError
    : bridge.navError;
  const effectiveNavigate = showWebviewPreview
    ? onWebviewNavigate
    : bridge.onNavigate;
  const effectiveGoBack = showWebviewPreview
    ? () => webviewRef.current?.goBack()
    : bridge.onGoBack;
  const effectiveGoForward = showWebviewPreview
    ? () => webviewRef.current?.goForward()
    : bridge.onGoForward;
  const effectiveReload = showWebviewPreview
    ? () => webviewRef.current?.reload()
    : bridge.onReload;
  const effectiveForceReload = showWebviewPreview
    ? () => webviewRef.current?.forceReload()
    : bridge.onForceReload;
  const effectiveOpenExternal = showWebviewPreview
    ? onWebviewOpenExternal
    : bridge.onOpenExternal;
  const effectiveGetZoom = showWebviewPreview
    ? onWebviewGetZoom
    : bridge.onGetZoom;
  const effectiveSetZoom = showWebviewPreview
    ? onWebviewSetZoom
    : bridge.onSetZoom;
  const currentPageIdentity = normalizePreviewPageIdentity(
    effectivePageStatus.url ?? effectiveInputUrl,
  );
  const savedAnnotations = usePreviewAnnotationStore(
    (s) => s.byThread[threadId] ?? EMPTY_SAVED_ANNOTATIONS,
  );
  const pageAnnotations = useMemo(
    () =>
      savedAnnotations.filter(
        (annotation) => annotation.pageIdentity === currentPageIdentity,
      ),
    [savedAnnotations, currentPageIdentity],
  );
  const bundleCount = annotationSignal;
  const editingSavedAnnotation = editingAnnotationId
    ? pageAnnotations.find(
        (annotation) => annotation.id === editingAnnotationId,
      )
    : undefined;
  const openBubbleBase =
    draftAnnotation ??
    (editingSavedAnnotation
      ? draftFromSaved(threadId, editingSavedAnnotation)
      : undefined);
  const openBubbleProposedChanges = openBubbleBase
    ? cleanVisualProposal(bubbleVisuals, openBubbleBase.elementStyle)
    : undefined;
  const canSaveOpenBubble =
    Boolean(openBubbleBase) &&
    (bubbleNote.trim().length > 0 ||
      hasVisualProposal(openBubbleProposedChanges));
  const hasOpenBubble = Boolean(openBubbleBase);
  const openBubbleFocusKey = draftAnnotation
    ? `draft:${draftAnnotation.pageIdentity}:${draftAnnotation.bounds.x}:${draftAnnotation.bounds.y}:${draftAnnotation.bounds.width}:${draftAnnotation.bounds.height}`
    : editingAnnotationId
      ? `edit:${editingAnnotationId}`
      : null;
  const annotationHeaderPageLabel =
    currentPageIdentity || effectiveInputUrl || "current page";

  // Page events flow through `preview:page-status`, not `preview:tabs-updated`
  // (P2), so the host-truth tab set lags the active page's live chrome. Publish
  // it to the store so the rail's page switcher and Browser glyph reflect the
  // active page as it navigates, without re-serializing the whole tab set on
  // every favicon tick. Clear on unmount so a backgrounded scope falls back to
  // each tab's own persisted favicon rather than a stale overlay.
  useEffect(() => {
    usePreviewTabsStore.getState().setLiveChrome(threadId, {
      title: effectivePageStatus.title,
      url: effectivePageStatus.url,
      favicon: effectivePageStatus.favicon,
    });
  }, [threadId, effectivePageStatus]);
  useEffect(() => {
    return () => {
      usePreviewTabsStore.getState().setLiveChrome(threadId, null);
    };
  }, [threadId]);

  useEffect(() => {
    if (!draftAnnotation) return;
    setEditingAnnotationId(null);
    setBubbleNote(draftAnnotation.note);
    setBubbleVisuals(
      initialVisualControls(
        draftAnnotation.elementStyle,
        draftAnnotation.proposedChanges,
      ),
    );
    setBubbleAdvancedOpen(false);
    setOutsideWarned(false);
  }, [draftAnnotation]);

  useEffect(() => {
    if (!editingSavedAnnotation) return;
    const elementStyle =
      editingSavedAnnotation.pageContext.elementStyle ??
      editingSavedAnnotation.snapshot.capture.elementStyle;
    setBubbleNote(editingSavedAnnotation.note ?? "");
    setBubbleVisuals(
      initialVisualControls(
        elementStyle,
        editingSavedAnnotation.proposedChanges,
      ),
    );
    setBubbleAdvancedOpen(false);
    setOutsideWarned(false);
  }, [editingSavedAnnotation]);

  useEffect(() => {
    if (!openBubbleFocusKey) return;
    const frame = window.requestAnimationFrame(() => {
      bubbleNoteInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [openBubbleFocusKey]);

  useEffect(() => {
    if (!designModeActive || !hasOpenBubble) return;
    let cancelled = false;
    void window.desktopBridge?.preview?.design
      ?.setAnnotationGuard(true)
      .catch(() => undefined);
    return () => {
      if (cancelled) return;
      cancelled = true;
      void window.desktopBridge?.preview?.design
        ?.setAnnotationGuard(false)
        .catch(() => undefined);
    };
  }, [designModeActive, hasOpenBubble]);

  const closeOpenAnnotationBubble = useCallback((): void => {
    usePreviewAnnotationStore.getState().setDraft(threadId, undefined);
    setEditingAnnotationId(null);
    setBubbleAdvancedOpen(false);
    setOutsideWarned(false);
  }, [threadId]);

  const requestOutsideBubbleDiscard = useCallback((): void => {
    if (!openBubbleBase) return;
    if (!canSaveOpenBubble) {
      closeOpenAnnotationBubble();
      return;
    }
    if (!outsideWarned) {
      setOutsideWarned(true);
      return;
    }
    closeOpenAnnotationBubble();
  }, [
    canSaveOpenBubble,
    closeOpenAnnotationBubble,
    openBubbleBase,
    outsideWarned,
  ]);

  const linkedPeersForKey = useCallback(
    (key: VisualProposalKey): VisualProposalKey[] => {
      return VISUAL_LINK_PAIRS.flatMap((pair) => {
        if (!linkedVisualPairs[pair.id]) return [];
        if (!(pair.keys as readonly VisualProposalKey[]).includes(key)) return [];
        return pair.keys.filter((candidate) => candidate !== key);
      });
    },
    [linkedVisualPairs],
  );

  const updateBubbleVisualControl = useCallback(
    (key: VisualProposalKey, rawValue: string | number): void => {
      const nextValue =
        typeof rawValue === "number"
          ? rawValue
          : encodeVisualControlValue(key, rawValue);
      const linkedPeers = linkedPeersForKey(key);
      setBubbleVisuals((prev) => {
        const next: Record<string, string | number> = { ...prev, [key]: nextValue };
        for (const peer of linkedPeers) next[peer] = nextValue;
        return next as PreviewAnnotationVisualProposal;
      });
      setOutsideWarned(false);
    },
    [linkedPeersForKey],
  );

  const toggleVisualLinkPair = useCallback(
    (pairId: VisualLinkPairId): void => {
      const pair = VISUAL_LINK_PAIRS.find((candidate) => candidate.id === pairId);
      if (!pair) return;
      const willEnable = !linkedVisualPairs[pairId];
      setLinkedVisualPairs((prev) => ({ ...prev, [pairId]: willEnable }));
      if (!willEnable) return;
      setBubbleVisuals((prev) => {
        const source = prev[pair.keys[0]];
        if (source === undefined || String(source).trim() === "") return prev;
        return {
          ...prev,
          [pair.keys[1]]: source,
        };
      });
      setOutsideWarned(false);
    },
    [linkedVisualPairs],
  );

  const updateColorFormat = useCallback(
    (key: ColorVisualProposalKey, format: ColorFormat): void => {
      setColorFormats((prev) => ({ ...prev, [key]: format }));
      const parsed = parseColorValue(bubbleVisuals[key]);
      if (!parsed) return;
      updateBubbleVisualControl(key, formatColorValue(parsed, format));
    },
    [bubbleVisuals, updateBubbleVisualControl],
  );

  useEffect(() => {
    if (!openBubbleBase) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target && bubbleRef.current?.contains(target)) return;
      if (
        target instanceof Element &&
        target.closest("[data-preview-design-keep-open]")
      ) {
        return;
      }
      requestOutsideBubbleDiscard();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [openBubbleBase, requestOutsideBubbleDiscard]);

  const clearTransientAnnotationState = closeOpenAnnotationBubble;

  const handleDesignEscape = useCallback((): void => {
    if (hasOpenBubble) {
      closeOpenAnnotationBubble();
      return;
    }
    closeOpenAnnotationBubble();
    designModeSetActive(threadId, false);
    void window.desktopBridge?.preview?.cancelCapture();
  }, [
    closeOpenAnnotationBubble,
    designModeSetActive,
    hasOpenBubble,
    threadId,
  ]);

  // Design mode is a single state: "next click on the page captures the
  // element under the cursor, repeat until you turn the mode off." Toggling it
  // off cancels any in-flight capture so the picker never sticks.
  const onToggleDesignMode = () => {
    const willActivate = !designModeActive;
    designModeToggle(threadId);
    if (!willActivate) {
      clearTransientAnnotationState();
      void window.desktopBridge?.preview?.cancelCapture();
    }
  };

  useEffect(() => {
    if (!designModeActive || hasOpenBubble) return;
    let cancelled = false;
    const pickNext = async (): Promise<void> => {
      if (!usePreviewDesignModeStore.getState().isActive(threadId)) return;
      const result = await capture.onAddElementAnnotation();
      if (cancelled) return;
      if (!result.ok) {
        // Cancel / error / Esc-in-guest: exit the mode entirely so the
        // user has a single, consistent way to escape a sticky picker.
        clearTransientAnnotationState();
        designModeSetActive(threadId, false);
      }
    };
    void pickNext();
    return () => {
      cancelled = true;
    };
  }, [
    designModeActive,
    hasOpenBubble,
    threadId,
    capture.onAddElementAnnotation,
    clearTransientAnnotationState,
    designModeSetActive,
  ]);

  // Esc must exit design mode no matter where focus is. The global
  // escape.handle binding (default-keybindings.json) closes the current
  // thread on Esc, which would yank the user out of their workspace mid
  // pick session. We attach at capture phase with stopImmediatePropagation
  // so this listener fires before the global keybinding-manager dispatch.
  useEffect(() => {
    if (!designModeActive) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      handleDesignEscape();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [designModeActive, handleDesignEscape]);

  useEffect(() => {
    if (!designModeActive) return;
    const onDesignEscape = (event: Event): void => {
      const detail = (event as CustomEvent<{ threadId?: string }>).detail;
      if (detail?.threadId && detail.threadId !== threadId) return;
      event.preventDefault();
      handleDesignEscape();
    };
    window.addEventListener("mcode:preview-design-escape", onDesignEscape);
    return () =>
      window.removeEventListener("mcode:preview-design-escape", onDesignEscape);
  }, [designModeActive, handleDesignEscape, threadId]);

  if (!window.desktopBridge?.preview) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground"
        data-testid="preview-panel-unavailable"
      >
        <Globe className="size-8 opacity-50" aria-hidden />
        <p className="max-w-xs text-balance">
          Embedded preview runs in the desktop app. Open Mcode from Electron to
          browse http and https sites alongside this thread.
        </p>
      </div>
    );
  }

  const hasLoadedPage = showWebviewPreview
    ? !!(webviewSrc ?? webviewPageStatus.url)
    : bridge.storedUrl.trim().length > 0;
  const pageError =
    effectivePageStatus.phase === "error"
      ? effectivePageStatus.error
      : undefined;
  const showLocalPorts =
    !hasLoadedPage && !effectivePreviewLoading && !pageError;
  const requestComposerSubmit = (): void => {
    window.dispatchEvent(
      new CustomEvent("mcode:submit-composer", {
        detail: { threadId, source: "preview-annotation" },
      }),
    );
  };

  const saveOpenBubble = async (
    options: { readonly sendAfterSave?: boolean } = {},
  ): Promise<void> => {
    if (!openBubbleBase) return;
    const proposedChanges = cleanVisualProposal(
      bubbleVisuals,
      openBubbleBase.elementStyle,
    );
    if (bubbleNote.trim().length === 0 && !proposedChanges) {
      setOutsideWarned(true);
      return;
    }
    const markerByDisplayNumber = new Map<
      number,
      PreviewAnnotationSnapshotRequest["markers"][number]
    >();
    for (const annotation of pageAnnotations) {
      markerByDisplayNumber.set(annotation.displayNumber, {
        displayNumber: annotation.displayNumber,
        bounds: annotation.targetContext.bounds,
      });
    }
    const activeDisplayNumber =
      editingSavedAnnotation?.displayNumber ?? savedAnnotations.length + 1;
    markerByDisplayNumber.set(activeDisplayNumber, {
      displayNumber: activeDisplayNumber,
      bounds: openBubbleBase.bounds,
    });
    const activeHighlightBounds = visualProposalBounds(
      openBubbleBase.bounds,
      proposedChanges,
      openBubbleBase.elementStyle,
    );
    const snapshot = await capture.captureAnnotationSnapshot({
      activeDisplayNumber,
      activeBounds: activeHighlightBounds,
      markers: Array.from(markerByDisplayNumber.values()),
    });
    if (!snapshot) return;
    usePreviewAnnotationStore.getState().saveAnnotation(
      threadId,
      {
        ...openBubbleBase,
        note: bubbleNote,
        proposedChanges,
        snapshot,
      },
      editingAnnotationId ?? undefined,
    );
    setEditingAnnotationId(null);
    setOutsideWarned(false);
    if (options.sendAfterSave) requestComposerSubmit();
  };

  const onBubbleNoteKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
  ): void => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    void saveOpenBubble({ sendAfterSave: event.ctrlKey || event.metaKey });
  };

  const deleteOpenBubble = (): void => {
    if (editingAnnotationId) {
      usePreviewAnnotationStore
        .getState()
        .deleteAnnotation(threadId, editingAnnotationId);
    } else {
      usePreviewAnnotationStore.getState().setDraft(threadId, undefined);
    }
    setEditingAnnotationId(null);
    setBubbleAdvancedOpen(false);
    setOutsideWarned(false);
  };

  const visibleOpenBubbleBase = designModeActive ? openBubbleBase : undefined;
  const visiblePageAnnotations = designModeActive
    ? pageAnnotations
    : EMPTY_SAVED_ANNOTATIONS;
  const openBubbleVisualProposal = visibleOpenBubbleBase
    ? cleanVisualProposal(bubbleVisuals, visibleOpenBubbleBase.elementStyle)
    : undefined;
  const previewSurfaceWidth = surfaceRef.current?.clientWidth ?? 0;
  const showAnnotationCommandBar = designModeActive && bundleCount > 0;

  return (
    <div
      data-testid="preview-panel"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className={cn(showWebviewPreview && "relative z-20")}>
        {showAnnotationCommandBar ? (
          <PreviewAnnotationHeader
            pageCount={pageAnnotations.length}
            bundleCount={bundleCount}
            pageLabel={annotationHeaderPageLabel}
            onDiscardPage={() => {
              usePreviewAnnotationStore
                .getState()
                .discardPage(threadId, currentPageIdentity);
            }}
            onSend={requestComposerSubmit}
            onExit={() => {
              clearTransientAnnotationState();
              designModeSetActive(threadId, false);
              void window.desktopBridge?.preview?.cancelCapture();
            }}
          />
        ) : (
          <BrowserHeader
            url={effectiveInputUrl}
            pageTitle={effectivePageTitle}
            faviconUrl={effectiveFaviconUrl}
            hasLoadedPage={hasLoadedPage}
            canBack={effectiveCanBack}
            canFwd={effectiveCanFwd}
            threadId={threadId}
            designModeActive={designModeActive}
            elementPickBusy={capture.elementPickBusy}
            captureBusy={capture.captureBusy}
            regionBusy={capture.regionBusy}
            focusRequest={omniboxFocusTick}
            onNavigate={effectiveNavigate}
            onGoBack={effectiveGoBack}
            onGoForward={effectiveGoForward}
            onReload={effectiveReload}
            onOpenExternal={effectiveOpenExternal}
            onToggleDesign={onToggleDesignMode}
            onScreenshot={capture.onAddPictureReference}
            onNewPage={tabs.newTab}
            onForceReload={effectiveForceReload}
            onRegionCapture={capture.onAddRegionPictureReference}
            onDumpContent={capture.onAddPageContextOnly}
            onClearCookies={bridge.onClearCookies}
            onClearCache={bridge.onClearCache}
            onGetZoom={effectiveGetZoom}
            onSetZoom={effectiveSetZoom}
            suppressPreviewForOverlays={!showWebviewPreview}
          />
        )}
      </div>

      {effectiveNavError ? (
        <p
          className="flex-none px-3 py-1 text-xs text-destructive"
          role="status"
        >
          {effectiveNavError}
        </p>
      ) : null}

      {/* Surface aligned to the native BrowserView. When nothing is loaded the
          localhost-ports list owns the surface; once a page loads the native
          guest paints over it. */}
      <div
        ref={surfaceRef}
        role="region"
        aria-label="Page preview"
        data-testid="preview-surface"
        className={cn(
          "relative min-h-[min(40vh,20rem)] min-w-0 flex-1",
          showWebviewPreview
            ? "z-0 overflow-hidden rounded-tl-md"
            : "mx-2 mb-2 mt-1 rounded-md border border-border/40 bg-muted/10",
          showLocalPorts && "overflow-y-auto",
        )}
      >
        {/* Loading: thin indeterminate progress bar at top of content area.
            motion-safe gates the animation so users with prefers-reduced-motion
            get a static bar instead of a perpetual sweep. */}
        {effectivePreviewLoading ? (
          <div
            data-testid="preview-loading-banner"
            className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden rounded-t-md"
            role="status"
            aria-live="polite"
            aria-label="Page loading"
          >
            <div className="h-full w-1/3 motion-safe:animate-preview-loading rounded-full bg-primary/80" />
          </div>
        ) : null}
        {lastCapture ? (
          // Brief acknowledgement of a successful attachment. Sits in the
          // bottom-right so it never overlaps the loading banner at the top
          // and never blocks the page's interactive area. Auto-dismiss after
          // ~2.2s via the host timer.
          <div
            role="status"
            aria-live="polite"
            data-testid="preview-capture-confirmation"
            className={cn(
              "pointer-events-none absolute right-2 bottom-2 z-10 flex items-center gap-1.5",
              // No backdrop-blur: the BrowserView paints opaque underneath
              // anyway, so the blur is a no-op render cost. bg-background/90
              // gives enough contrast over any guest page color.
              "rounded-sm border border-primary/30 bg-background/90 px-2 py-1 shadow-sm",
              "font-mono text-xs uppercase tracking-[0.14em] text-primary",
              "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1",
            )}
          >
            <Check size={11} aria-hidden />
            <span>attached</span>
            <span className="text-primary/60">{"\u00b7"}</span>
            <span>{CAPTURE_KIND_LABEL[lastCapture]}</span>
          </div>
        ) : null}
        {showWebviewPreview ? (
          <div
            data-testid="preview-webview-surface"
            className="absolute inset-0 z-0 overflow-hidden rounded-tl-md"
          >
            {webviewSrc ? (
              <PreviewWebview
                ref={webviewRef}
                threadId={threadId}
                tabId={activeWebviewTabId}
                src={webviewSrc}
                className="relative z-0 h-full w-full"
                onPageStatus={onWebviewPageStatus}
                onNavigationStateChange={(state) => {
                  setWebviewCanBack(state.canGoBack);
                  setWebviewCanFwd(state.canGoForward);
                }}
              />
            ) : null}
          </div>
        ) : null}
        {visiblePageAnnotations.map((annotation) => {
          const targetLabel =
            annotation.targetContext.label?.trim() ||
            annotation.targetContext.selectorHint?.trim() ||
            "Element";
          const note = annotation.note?.trim() || "Visual annotation";
          return (
            <Tooltip key={annotation.id}>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    data-testid="preview-annotation-marker"
                    variant="ghost"
                    size="icon-sm"
                    className="group/marker absolute z-20 flex size-8 items-center justify-center rounded-full bg-transparent p-0 hover:bg-transparent focus-visible:bg-transparent"
                    style={{
                      left: Math.max(
                        16,
                        annotation.targetContext.bounds.x +
                          annotation.targetContext.bounds.width / 2,
                      ),
                      top: Math.max(
                        16,
                        annotation.targetContext.bounds.y +
                          Math.min(annotation.targetContext.bounds.height / 2, 18),
                      ),
                      transform: "translate(-50%, -50%)",
                    }}
                    onClick={() => {
                      setEditingAnnotationId(annotation.id);
                    }}
                    aria-label={`Edit annotation ${annotation.displayNumber}`}
                  >
                    <span
                      className="relative flex size-7 items-center justify-center rounded-full bg-primary/80 text-primary-foreground/90 shadow-sm ring-1 ring-background/80 transition-transform duration-150 group-hover/marker:scale-105 group-focus-visible/marker:scale-105"
                      aria-hidden
                    >
                      <span className="absolute -bottom-0.5 left-1.5 size-2 rotate-45 rounded-sm bg-primary/80" />
                      <span className="relative z-10 text-xs font-semibold tabular-nums">
                        {annotation.displayNumber}
                      </span>
                    </span>
                  </Button>
                }
              />
              <TooltipContent
                side="top"
                sideOffset={8}
                className="max-w-72 flex-col items-start gap-1.5 rounded-lg border border-white/10 bg-[#262626] px-3 py-2 text-neutral-100 shadow-xl"
                arrowClassName="bg-[#262626] fill-[#262626]"
              >
                <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs text-neutral-300">
                  {targetLabel}
                </span>
                <span className="whitespace-pre-wrap text-xs leading-snug">
                  {note}
                </span>
              </TooltipContent>
            </Tooltip>
          );
        })}
        {visibleOpenBubbleBase ? (
          <div
            data-testid="preview-annotation-active-target-highlight"
            className="pointer-events-none absolute z-10 rounded-sm border-2 border-primary/80 bg-primary/10"
            style={{
              left: visibleOpenBubbleBase.bounds.x,
              top: visibleOpenBubbleBase.bounds.y,
              width: visibleOpenBubbleBase.bounds.width,
              height: visibleOpenBubbleBase.bounds.height,
            }}
          />
        ) : null}
        {visibleOpenBubbleBase && openBubbleVisualProposal ? (
          <div
            data-testid="preview-annotation-visual-proposal"
            className="pointer-events-none absolute z-10 rounded-sm border border-dashed border-primary/80"
            style={{
              ...visualOverlayStyle(openBubbleVisualProposal),
              ...visualProposalGeometryStyle(
                visibleOpenBubbleBase.bounds,
                openBubbleVisualProposal,
                visibleOpenBubbleBase.elementStyle,
              ),
            }}
          />
        ) : null}
        {visibleOpenBubbleBase ? (
          <div
            aria-hidden
            data-testid="preview-annotation-discard-overlay"
            className="absolute inset-0 z-20 bg-transparent"
          />
        ) : null}
        {visibleOpenBubbleBase ? (
          <div
            ref={bubbleRef}
            data-testid="preview-annotation-bubble"
            className={cn(
              "absolute z-30 w-[min(20.5rem,calc(100%-1rem))] overflow-hidden rounded-[1.65rem] border bg-[#282828] text-neutral-50 shadow-xl",
              outsideWarned
                ? "animate-preview-annotation-shake border-destructive/80"
                : "border-white/10",
              bubbleAdvancedOpen ? "max-h-[20.5rem]" : "min-h-11",
            )}
            style={annotationBubbleStyle(
              visibleOpenBubbleBase.bounds,
              previewSurfaceWidth,
            )}
          >
            <div className="flex min-h-11 items-center gap-2 px-3 py-1.5">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="shrink-0 rounded-full text-neutral-300 hover:bg-white/10 hover:text-white"
                data-testid="preview-annotation-advanced-toggle"
                aria-label="Open annotation visual controls"
                aria-expanded={bubbleAdvancedOpen}
                onClick={() => setBubbleAdvancedOpen((value) => !value)}
              >
                <SlidersHorizontal size={15} aria-hidden />
              </Button>
              <Input
                ref={bubbleNoteInputRef}
                value={bubbleNote}
                onChange={(event) => {
                  setBubbleNote(event.target.value);
                  setOutsideWarned(false);
                }}
                onKeyDown={onBubbleNoteKeyDown}
                className="h-7 min-w-0 flex-1 border-0 bg-transparent px-0 text-sm text-neutral-50 shadow-none outline-none placeholder:text-neutral-500 focus-visible:ring-0"
                maxLength={4000}
                placeholder="Add a comment..."
                aria-label="Annotation note"
              />
              {canSaveOpenBubble ? (
                <Button
                  type="button"
                  data-testid="preview-annotation-save"
                  size="icon-sm"
                  className="size-8 shrink-0 rounded-full bg-neutral-100 text-neutral-950 hover:bg-white"
                  aria-label="Save annotation"
                  onClick={() => void saveOpenBubble()}
                >
                  <Check size={16} aria-hidden />
                </Button>
              ) : null}
            </div>
            {bubbleAdvancedOpen ? (
              <div
                data-testid="preview-annotation-advanced"
                className="border-t border-white/10 bg-[#282828]"
              >
                <div className="flex items-center justify-between bg-white/[0.06] px-4 py-2 text-xs text-neutral-200">
                  <span className="max-w-[15rem] truncate font-semibold">
                    {visibleOpenBubbleBase.label?.trim() ||
                      visibleOpenBubbleBase.selectorHint?.trim() ||
                      "Element"}
                  </span>
                  <GripVertical
                    size={14}
                    className="text-neutral-500"
                    aria-hidden
                  />
                </div>
                <div className="max-h-52 overflow-y-auto px-4 py-2.5 [scrollbar-color:rgb(115_115_115)_transparent] [scrollbar-width:thin]">
                  <div className="space-y-2.5">
                    {VISUAL_CONTROL_FIELDS.map(([key, label]) => {
                      if (key in COLOR_CONTROL_DEFAULTS) {
                        const colorKey = key as ColorVisualProposalKey;
                        return (
                          <ColorInspectorControl
                            key={key}
                            controlKey={colorKey}
                            colorFormat={
                              colorFormats[colorKey] ??
                              detectColorFormat(bubbleVisuals[colorKey])
                            }
                            label={label}
                            value={bubbleVisuals[colorKey]}
                            onChange={updateBubbleVisualControl}
                            onFormatChange={updateColorFormat}
                          />
                        );
                      }
                      const value = bubbleVisuals[key];
                      return (
                        <InspectorRow
                          key={key}
                          label={label}
                        >
                          <InspectorValueInput
                            controlKey={key}
                            label={label}
                            value={value}
                            onChange={updateBubbleVisualControl}
                          />
                        </InspectorRow>
                      );
                    })}
                    <LinkedSizeControls
                      linked={Boolean(linkedVisualPairs.size)}
                      values={bubbleVisuals}
                      onChange={updateBubbleVisualControl}
                      onToggleLinked={() => toggleVisualLinkPair("size")}
                    />
                    {[...BOX_CONTROL_GROUPS, RADIUS_CONTROL_GROUP].map((group) => (
                      <ExpandableQuadGroup
                        key={group.id}
                        groupId={group.id}
                        label={group.label}
                        entries={
                          group.id === "radius"
                            ? radiusGroupEntries(group)
                            : boxGroupEntries(group)
                        }
                        expanded={Boolean(expandedVisualGroups[group.id])}
                        linkedPairs={groupLinkPairs(group.id)}
                        linkedPairState={linkedVisualPairs}
                        values={bubbleVisuals}
                        onChange={updateBubbleVisualControl}
                        onToggleExpanded={(groupId) => {
                          setExpandedVisualGroups((prev) => ({
                            ...prev,
                            [groupId]: !prev[groupId],
                          }));
                        }}
                        onToggleLinked={toggleVisualLinkPair}
                      />
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
            {bubbleAdvancedOpen || editingAnnotationId ? (
              <div className="flex items-center justify-between border-t border-white/10 px-3 py-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-full text-neutral-200 hover:bg-red-500/20 hover:text-red-100"
                  aria-label="Delete annotation"
                  onClick={deleteOpenBubble}
                >
                  <Trash2 size={15} aria-hidden />
                </Button>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 rounded-full px-3 text-neutral-100 hover:bg-white/10 hover:text-white"
                    onClick={() => {
                      usePreviewAnnotationStore
                        .getState()
                        .setDraft(threadId, undefined);
                      setEditingAnnotationId(null);
                      setBubbleAdvancedOpen(false);
                      setOutsideWarned(false);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 rounded-full bg-neutral-100 px-3 text-neutral-950 hover:bg-white"
                    disabled={!canSaveOpenBubble}
                    onClick={() => void saveOpenBubble()}
                  >
                    Save
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        {pageError ? (
          // Approach A: the native view is hidden (bridge syncs visible:false
          // while phase === "error"), so this HTML panel owns the surface and
          // names the failure with recovery actions.
          <PreviewErrorPanel
            error={pageError}
            url={effectivePageStatus.url}
            canBack={effectiveCanBack}
            onRetry={() => void effectiveReload()}
            onGoBack={() => void effectiveGoBack()}
          />
        ) : null}
        {showLocalPorts ? (
          <LocalPortsEmptyState
            active={showLocalPorts}
            onOpenPort={(port) => effectiveNavigate(`http://localhost:${port}`)}
          />
        ) : null}
      </div>
      <PreviewPerfHud />
    </div>
  );
}
