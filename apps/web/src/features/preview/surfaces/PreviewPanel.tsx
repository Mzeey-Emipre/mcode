import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Globe,
  GripVertical,
  Link2,
  MousePointer2,
  Pipette,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import type {
  PreviewAnnotationVisualProposal,
  PreviewPageStatus,
} from "@mcode/contracts";
import { BROWSER_AUTOMATION_VIEWPORT_CANVAS_PADDING_PX } from "@mcode/contracts";
import type { PreviewAnnotationSnapshotRequest } from "@/transport/desktop-bridge";
import { isEmptyPreviewTabUrl } from "../navigation/open-url-in-preview";
import { cn } from "@/lib/utils";
import { useDiffStore } from "@/stores/diffStore";
import { usePreviewDesignModeStore } from "../state/previewDesignModeStore";
import { usePreviewFocusStore } from "../state/previewFocusStore";
import { usePreviewTabsStore } from "../state/previewTabsStore";
import { BrowserHeader } from "./BrowserHeader";
import { BrowserViewportToolbar } from "./BrowserViewportToolbar";
import {
  BrowserViewportCanvas,
} from "./BrowserViewportCanvas";
import { PreviewAnnotationHeader } from "./PreviewAnnotationHeader";
import { LocalPortsEmptyState } from "./LocalPortsEmptyState";
import { PreviewErrorPanel } from "./PreviewErrorPanel";
import { PreviewPerfHud } from "./PreviewPerfHud";
import { PreviewWebview, type PreviewWebviewHandle } from "./PreviewWebview";
import { formatNavError, usePreviewBridge } from "../navigation/usePreviewBridge";
import {
  usePreviewCapture,
  type PreviewCaptureKind,
} from "../capture/usePreviewCapture";
import { usePreviewTabs } from "../tabs/usePreviewTabs";
import {
  normalizePreviewPageIdentity,
  type PreviewDraftAnnotation,
  type SavedPreviewAnnotation,
  usePreviewAnnotationStore,
} from "../state/previewAnnotationStore";
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
import { useSlashCommand } from "@/components/chat/useSlashCommand";
import { SlashCommandPopup } from "@/components/chat/SlashCommandPopup";
import type { Command } from "@/components/chat/useSlashCommand";
import { useFileAutocomplete } from "@/components/chat/useFileAutocomplete";
import {
  FileTagPopup,
  useFileTagPopup,
} from "@/components/chat/FileTagPopup";
import type { MentionSuggestion } from "@/components/chat/useFileAutocomplete";
import { useWorkspaceThread } from "@/features/projects/state/workspace-selectors";
import {
  browserAutomationTargetKey,
  isBrowserAutomationAgentControlled,
  interruptBrowserAutomationTarget,
  invalidateBrowserAutomationTargetObservation,
  selectWarmBrowserTabIds,
  useBrowserAutomationStore,
} from "../automation/browserAutomationStore";
import {
  isBrowserAutomationWebRuntimeEnabled,
  normalizeWebPreviewUrl,
  resolveWebPreviewState,
} from "../automation/browserAutomationRuntime";
import {
  calculateViewportPresentationScale,
  DEFAULT_VIEWPORT_SIZE,
  type ViewportCoordinator,
  type ViewportCoordinatorState,
} from "../automation/services/viewportCoordinator";
import {
  getOrCreateViewportCoordinator,
  waitForViewportLayout,
} from "../automation/services/viewportCoordinatorFactory";
import type {
  BrowserSurfaceIdentity,
  BrowserSurfacePageState,
} from "../browser-surfaces";
import {
  browserSurfaceHost,
  browserSurfacePresentationCoordinator,
} from "./BrowserSurfaceHostRoot";
import type {
  BrowserSurfacePresentationRegistration,
  BrowserSurfacePresentationSource,
} from "./BrowserSurfacePresentationCoordinator";

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
function fitViewportCanvasBounds(bounds: { readonly width: number; readonly height: number }): {
  readonly width: number;
  readonly height: number;
} {
  return {
    width: Math.max(0, bounds.width - BROWSER_AUTOMATION_VIEWPORT_CANVAS_PADDING_PX),
    height: Math.max(0, bounds.height - BROWSER_AUTOMATION_VIEWPORT_CANVAS_PADDING_PX),
  };
}

// ---------------------------------------------------------------------------
// Annotation bubble dark palette
// Hardcoded dark values intentional: the bubble floats over arbitrary user
// web content in the preview, so theme tokens (which go light in light mode)
// would make text unreadable. These two values must stay in sync with the
// tooltip, advanced panel, and any autocomplete popups adjacent to the bubble.
// ---------------------------------------------------------------------------
/** Primary bubble surface used on the main row and the inspector panel. */
const BUBBLE_SURFACE = "#282828";
/** Inset/footer surface inside the bubble, slightly darker for depth. */
const BUBBLE_SURFACE_INSET = "#202020";

type VisualProposalKey = keyof PreviewAnnotationVisualProposal;
type ColorVisualProposalKey = Extract<
  VisualProposalKey,
  "textColor" | "background" | "borderColor"
>;
type ColorFormat = "rgb" | "hsl" | "hex";
interface EyeDropperConstructor {
  new (): {
    open: () => Promise<{ sRGBHex: string }>;
  };
}
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

function rgbToHsv(color: RgbaColor): { h: number; s: number; v: number } {
  const r = clampColorChannel(color.r) / 255;
  const g = clampColorChannel(color.g) / 255;
  const b = clampColorChannel(color.b) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    if (max === g) h = (b - r) / delta + 2;
    if (max === b) h = (r - g) / delta + 4;
    h *= 60;
  }
  return {
    h: h < 0 ? h + 360 : h,
    s: max === 0 ? 0 : delta / max,
    v: max,
  };
}

function hsvToRgb(h: number, s: number, v: number, a?: number): RgbaColor {
  const hue = ((h % 360) + 360) % 360;
  const sat = clampUnit(s);
  const value = clampUnit(v);
  const chroma = value * sat;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = value - chroma;
  const [r, g, b] =
    hue < 60
      ? [chroma, x, 0]
      : hue < 120
        ? [x, chroma, 0]
        : hue < 180
          ? [0, chroma, x]
          : hue < 240
            ? [0, x, chroma]
            : hue < 300
              ? [x, 0, chroma]
              : [chroma, 0, x];
  return {
    r: clampColorChannel((r + m) * 255),
    g: clampColorChannel((g + m) * 255),
    b: clampColorChannel((b + m) * 255),
    ...(a !== undefined ? { a } : {}),
  };
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

function formatColorNumber(value: number): string {
  return String(Math.round(value));
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
    ? "border-sky-300/[0.45] bg-sky-300/[0.15] text-sky-200"
    : "border-white/[0.08] bg-[#232323] text-neutral-500 hover:border-white/[0.15] hover:text-neutral-200";
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
        "size-5 rounded-full border p-0 shadow-none hover:bg-white/[0.08]",
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
          "h-7 rounded-md border-white/[0.08] bg-[#303030]/70 text-xs text-neutral-100 shadow-none placeholder:text-neutral-500 hover:border-white/[0.14] focus-visible:border-sky-300/40 focus-visible:ring-1 focus-visible:ring-sky-300/[0.35]",
          affordance === "px" && "pr-8",
          className,
        )}
      />
      {affordance === "px" ? (
        <span className="pointer-events-none absolute right-2 text-xs text-neutral-500">
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
    <div className="grid grid-cols-[5.25rem_minmax(0,1fr)] items-center gap-2 text-xs text-neutral-300">
      <span className="truncate text-neutral-300/90">{label}</span>
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
  const hsv = rgbToHsv(pickerColor);
  const hueColor = hsvToRgb(hsv.h, 1, 1);
  const EyeDropperApi = (
    window as Window & { EyeDropper?: EyeDropperConstructor }
  ).EyeDropper;
  const commitColor = useCallback(
    (next: RgbaColor) => {
      onChange(controlKey, formatColorValue(next, colorFormat));
    },
    [colorFormat, controlKey, onChange],
  );
  const pickFromScreen = useCallback(() => {
    if (!EyeDropperApi) return;
    const eyeDropper = new EyeDropperApi();
    void eyeDropper
      .open()
      .then(({ sRGBHex }) => {
        const next = parseColorValue(sRGBHex);
        if (!next) return;
        commitColor({ ...next, a: pickerColor.a });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        throw error;
      });
  }, [EyeDropperApi, commitColor, pickerColor.a]);
  const updateFromPlane = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const saturation = clampUnit((event.clientX - rect.left) / rect.width);
      const value = clampUnit(1 - (event.clientY - rect.top) / rect.height);
      commitColor(hsvToRgb(hsv.h, saturation, value, pickerColor.a));
    },
    [commitColor, hsv.h, pickerColor.a],
  );
  const updateFromHue = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      if (rect.width <= 0) return;
      const hue = clampUnit((event.clientX - rect.left) / rect.width) * 360;
      commitColor(hsvToRgb(hue, hsv.s, hsv.v, pickerColor.a));
    },
    [commitColor, hsv.s, hsv.v, pickerColor.a],
  );
  const updatePlaneFromKeyboard = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 0.1 : 0.01;
      let nextSaturation = hsv.s;
      let nextValue = hsv.v;
      switch (event.key) {
        case "ArrowLeft":
          nextSaturation = clampUnit(hsv.s - step);
          break;
        case "ArrowRight":
          nextSaturation = clampUnit(hsv.s + step);
          break;
        case "ArrowDown":
          nextValue = clampUnit(hsv.v - step);
          break;
        case "ArrowUp":
          nextValue = clampUnit(hsv.v + step);
          break;
        case "Home":
          nextSaturation = 0;
          nextValue = 0;
          break;
        case "End":
          nextSaturation = 1;
          nextValue = 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      commitColor(hsvToRgb(hsv.h, nextSaturation, nextValue, pickerColor.a));
    },
    [commitColor, hsv.h, hsv.s, hsv.v, pickerColor.a],
  );
  const updateHueFromKeyboard = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 10 : 1;
      let nextHue: number;
      switch (event.key) {
        case "ArrowLeft":
        case "ArrowDown":
          nextHue = Math.max(0, hsv.h - step);
          break;
        case "ArrowRight":
        case "ArrowUp":
          nextHue = Math.min(360, hsv.h + step);
          break;
        case "Home":
          nextHue = 0;
          break;
        case "End":
          nextHue = 360;
          break;
        default:
          return;
      }
      event.preventDefault();
      commitColor(hsvToRgb(nextHue, hsv.s, hsv.v, pickerColor.a));
    },
    [commitColor, hsv.h, hsv.s, hsv.v, pickerColor.a],
  );
  const updateRgbChannel = (channel: keyof Pick<RgbaColor, "r" | "g" | "b">) =>
    (event: ChangeEvent<HTMLInputElement>) => {
      commitColor({
        ...pickerColor,
        [channel]: clampColorChannel(Number(event.target.value)),
      });
    };
  const hsl = rgbToHsl(pickerColor);
  const updateHslChannel = (channel: "h" | "s" | "l") =>
    (event: ChangeEvent<HTMLInputElement>) => {
      const numeric = Number(event.target.value);
      const next = {
        h: channel === "h" ? numeric : hsl.h,
        s: channel === "s" ? numeric / 100 : hsl.s,
        l: channel === "l" ? numeric / 100 : hsl.l,
      };
      commitColor(hslToRgb(next.h, next.s, next.l, pickerColor.a));
    };
  const formatFields =
    colorFormat === "hex" ? (
      <Input
        size="xs"
        aria-label={`${label} HEX value`}
        value={colorToHex(pickerColor)}
        onChange={(event) => {
          const next = parseColorValue(event.target.value);
          if (next) commitColor({ ...next, a: pickerColor.a });
        }}
        className="h-7 rounded-md border-white/[0.08] bg-[#242424] font-mono text-xs text-neutral-100 shadow-none focus-visible:border-amber-300/50 focus-visible:ring-1 focus-visible:ring-amber-300/30"
      />
    ) : colorFormat === "hsl" ? (
      <div className="grid grid-cols-3 gap-1.5">
        {([
          ["H", "h", Math.round(hsl.h), "numeric"],
          ["S", "s", Math.round(hsl.s * 100), "numeric"],
          ["L", "l", Math.round(hsl.l * 100), "numeric"],
        ] as const).map(([fieldLabel, channel, channelValue, inputMode]) => (
          <label key={channel} className="min-w-0 space-y-1">
            <span className="block text-center font-mono text-xs uppercase text-neutral-500">
              {fieldLabel}
            </span>
            <Input
              size="xs"
              aria-label={`${label} ${fieldLabel}`}
              value={formatColorNumber(channelValue)}
              inputMode={inputMode}
              onChange={updateHslChannel(channel)}
              className="h-7 rounded-md border-white/[0.08] bg-[#242424] text-center font-mono text-xs text-neutral-100 shadow-none focus-visible:border-amber-300/50 focus-visible:ring-1 focus-visible:ring-amber-300/30"
            />
          </label>
        ))}
      </div>
    ) : (
      <div className="grid grid-cols-3 gap-1.5">
        {([
          ["R", "r", pickerColor.r, "numeric"],
          ["G", "g", pickerColor.g, "numeric"],
          ["B", "b", pickerColor.b, "numeric"],
        ] as const).map(([fieldLabel, channel, channelValue, inputMode]) => (
          <label key={channel} className="min-w-0 space-y-1">
            <span className="block text-center font-mono text-xs uppercase text-neutral-500">
              {fieldLabel}
            </span>
            <Input
              size="xs"
              aria-label={`${label} ${fieldLabel}`}
              value={formatColorNumber(channelValue)}
              inputMode={inputMode}
              onChange={updateRgbChannel(channel)}
              className="h-7 rounded-md border-white/[0.08] bg-[#242424] text-center font-mono text-xs text-neutral-100 shadow-none focus-visible:border-amber-300/50 focus-visible:ring-1 focus-visible:ring-amber-300/30"
            />
          </label>
        ))}
      </div>
    );
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
                className="absolute left-2 z-10 size-4 rounded-full border border-white/25 p-0 shadow-none ring-1 ring-black/20 hover:ring-white/20"
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
            data-testid={`preview-color-popover-${controlKey}`}
            className="w-64 rounded-lg border-white/10 bg-[#2a2a2a] p-2.5 text-neutral-100 shadow-2xl"
          >
            <div className="space-y-2.5">
              <div
                role="slider"
                tabIndex={0}
                aria-label={`Saturation and value for ${label}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(hsv.s * 100)}
                aria-valuetext={`${Math.round(hsv.s * 100)}% saturation, ${Math.round(hsv.v * 100)}% value`}
                data-testid={`preview-color-plane-${controlKey}`}
                className="relative h-28 touch-none overflow-hidden rounded-md border border-white/[0.09] outline-none ring-black/30 focus-visible:ring-2 focus-visible:ring-amber-300/35"
                style={{
                  background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${colorToHex(hueColor)})`,
                }}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  updateFromPlane(event);
                }}
                onPointerMove={(event) => {
                  if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                  updateFromPlane(event);
                }}
                onKeyDown={updatePlaneFromKeyboard}
              >
                <span
                  aria-hidden
                  className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.65)]"
                  style={{
                    left: `${hsv.s * 100}%`,
                    top: `${(1 - hsv.v) * 100}%`,
                  }}
                />
              </div>
              <div
                role="slider"
                tabIndex={0}
                aria-label={`Hue for ${label}`}
                aria-valuemin={0}
                aria-valuemax={360}
                aria-valuenow={Math.round(hsv.h)}
                data-testid={`preview-color-hue-${controlKey}`}
                className="relative h-4 touch-none rounded-full border border-white/[0.1] outline-none ring-black/30 focus-visible:ring-2 focus-visible:ring-amber-300/35"
                style={{
                  background:
                    "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
                }}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  updateFromHue(event);
                }}
                onPointerMove={(event) => {
                  if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                  updateFromHue(event);
                }}
                onKeyDown={updateHueFromKeyboard}
              >
                <span
                  aria-hidden
                  className="absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.75)]"
                  style={{ left: `${(hsv.h / 360) * 100}%`, background: colorToHex(hueColor) }}
                />
              </div>
              <div className="flex items-center gap-2">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="inline-flex shrink-0 rounded-full">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Pick ${label} from screen`}
                          disabled={!EyeDropperApi}
                          onClick={pickFromScreen}
                          className="size-6 rounded-full text-neutral-200 hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:text-neutral-600"
                        >
                          <Pipette size={14} aria-hidden />
                        </Button>
                      </span>
                    }
                  />
                  <TooltipContent>
                    {EyeDropperApi
                      ? "Pick a color from the screen"
                      : "Screen color picker unavailable"}
                  </TooltipContent>
                </Tooltip>
                <span
                  aria-label={`Current ${label}`}
                  className="size-5 shrink-0 rounded-full border border-white/20 ring-1 ring-black/30"
                  style={{ background: colorToHex(pickerColor) }}
                />
                <div className="min-w-0 flex-1">{formatFields}</div>
              </div>
              <Input
                size="xs"
                aria-label={`Color picker for ${label}`}
                value={formatColorValue(pickerColor, colorFormat)}
                onChange={(event) => onChange(controlKey, event.target.value)}
                className="h-7 rounded-md border-white/[0.08] bg-[#242424] font-mono text-xs text-neutral-100 shadow-none focus-visible:border-amber-300/50 focus-visible:ring-1 focus-visible:ring-amber-300/30"
              />
              <div className="grid grid-cols-3 overflow-hidden rounded-md border border-white/[0.08] bg-[#252525]">
                {(["rgb", "hsl", "hex"] as const).map((format) => (
                  <Button
                    key={format}
                    type="button"
                    variant="ghost"
                    size="xs"
                    aria-label={`Use ${format.toUpperCase()} for ${label}`}
                    aria-pressed={colorFormat === format}
                    className={cn(
                      "h-7 rounded-none border-r border-white/[0.08] text-xs uppercase last:border-r-0",
                      colorFormat === format
                        ? "bg-white/[0.12] text-white"
                        : "text-neutral-400 hover:bg-white/[0.08] hover:text-white",
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
          className="h-7 rounded-md border-white/[0.08] bg-[#303030]/70 pl-8 font-mono text-xs text-neutral-100 shadow-none placeholder:text-neutral-500 hover:border-white/[0.14] focus-visible:border-sky-300/40 focus-visible:ring-1 focus-visible:ring-sky-300/[0.35]"
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
    <div className="grid grid-cols-[5.25rem_1.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1 text-xs text-neutral-300">
      <span className="text-neutral-300/90">Width</span>
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
      <span className="text-neutral-300/90">Height</span>
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
    <div className="grid min-w-0 grid-cols-4 overflow-hidden rounded-md border border-white/[0.08] bg-[#303030]/55">
      {entries.map((entry) => (
        <label
          key={entry.key}
          className="relative min-w-0 border-r border-white/[0.08] last:border-r-0"
        >
          <span className="sr-only">{entry.ariaLabel}</span>
          <Input
            size="xs"
            aria-label={entry.ariaLabel}
            value={displayVisualControlValue(entry.key, values[entry.key])}
            onChange={(event) => onChange(entry.key, event.target.value)}
            inputMode="decimal"
            className="h-7 rounded-none border-0 bg-transparent px-0 text-center font-mono text-xs tabular-nums text-neutral-100 shadow-none placeholder:text-neutral-500 hover:bg-white/[0.03] focus-visible:ring-1 focus-visible:ring-sky-300/35"
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
      <div className="grid grid-cols-[5.25rem_minmax(0,1fr)] items-center gap-2 text-xs text-neutral-300">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="-ml-1 h-7 justify-start gap-1 rounded-md px-1 text-xs text-neutral-300/90 hover:bg-transparent hover:text-white focus-visible:!border-white/[0.18] focus-visible:!ring-1 focus-visible:!ring-white/[0.18]"
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
    <div className="grid grid-cols-[4.5rem_1.25rem_minmax(3rem,1fr)] items-center gap-x-1.5 gap-y-1.5 border-t border-white/[0.08] pt-2 text-xs text-neutral-300 first:border-t-0 first:pt-0">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="col-span-3 -ml-1 h-6 w-[calc(100%+0.25rem)] justify-start gap-1 rounded-md px-1 text-xs text-neutral-300/90 hover:bg-white/[0.04] hover:text-white focus-visible:!border-white/[0.18] focus-visible:!bg-white/[0.06] focus-visible:!ring-1 focus-visible:!ring-white/[0.18]"
        aria-expanded
        onClick={() => onToggleExpanded(groupId)}
      >
        <ChevronDown size={13} aria-hidden />
        {label}
      </Button>
      {entries.map((entry, index) => {
        const link =
          index === 0 && firstPair
            ? firstPair
            : index === 2 && secondPair
              ? secondPair
              : undefined;
        return (
          <Fragment key={entry.key}>
            <span className="truncate text-neutral-300/[0.85]">{entry.label}</span>
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

/** Stable tab id used by the single web-runtime preview target. */
export const WEB_RUNTIME_PREVIEW_TAB_ID = "web-preview";
const WEB_AUTOMATION_FIXTURE_URL = "/browser-automation-fixture.html";

export interface PreviewPanelProps {
  /** Thread that owns preview state (URL memory and future captures). */
  readonly threadId: string;
  /** Active workspace id; scopes spill files under the Mcode app data dir (not the project tree). */
  readonly workspaceId?: string | null;
  /** Mount only automation webviews without visible panel chrome. */
  readonly automationOnly?: boolean;
  /** Whether this warm panel currently owns the visible Browser presentation. */
  readonly presentationActive?: boolean;
  /** Explicit overlap supplied by the active Activity Rail. */
  readonly coveredLeft?: number;
}

function useLiveViewportCoordinatorState(
  coordinator: ViewportCoordinator | undefined,
  projectedState: ViewportCoordinatorState | undefined,
): ViewportCoordinatorState | undefined {
  const [state, setState] = useState(projectedState);

  useEffect(() => {
    if (!coordinator) return;
    setState(coordinator.snapshot());
    return coordinator.subscribe(setState);
  }, [coordinator]);

  useEffect(() => {
    if (!coordinator) setState(projectedState);
  }, [coordinator, projectedState]);

  return state;
}

/** Visible same-origin iframe surface used by the worktree-local web runtime. */
function WebRuntimePreview({
  threadId,
  workspaceId,
  viewportCoordinator,
  viewportState,
  viewportToolbarOpen,
  onToggleViewportToolbar,
  onCloseViewportToolbar,
  automationOnly = false,
  presentationActive = true,
}: {
  readonly threadId: string;
  readonly workspaceId?: string | null;
  readonly viewportCoordinator?: ViewportCoordinator;
  readonly viewportState?: ViewportCoordinatorState;
  readonly viewportToolbarOpen: boolean;
  readonly onToggleViewportToolbar: () => void;
  readonly onCloseViewportToolbar: () => void;
  readonly automationOnly?: boolean;
  readonly presentationActive?: boolean;
}) {
  const storedUrl = useDiffStore((state) => state.previewUrlByThread[threadId] ?? "");
  const fixtureUrl = `${window.location.origin}${WEB_AUTOMATION_FIXTURE_URL}`;
  const [inputUrl, setInputUrl] = useState(storedUrl);
  const [requestedAddress, setRequestedAddress] = useState<string | null>(
    () => normalizeWebPreviewUrl(storedUrl) ?? fixtureUrl,
  );
  const requestedAddressRef = useRef(requestedAddress);
  requestedAddressRef.current = requestedAddress;
  const [pageState, setPageState] = useState<BrowserSurfacePageState | null>(null);
  const [crossOriginObserved, setCrossOriginObserved] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [canvasBounds, setCanvasBounds] = useState({ width: 0, height: 0 });
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const presentationRegistrationRef = useRef<BrowserSurfacePresentationRegistration | null>(null);
  const identity = useMemo<BrowserSurfaceIdentity>(() => ({
    workspaceId: workspaceId ?? threadId,
    scope: {
      kind: "thread",
      id: threadId,
    },
    tabId: WEB_RUNTIME_PREVIEW_TAB_ID,
  }), [threadId, workspaceId]);
  const enabled = isBrowserAutomationWebRuntimeEnabled();
  const requestedState = resolveWebPreviewState(requestedAddress, enabled);
  const state = crossOriginObserved ? "cross-origin" : requestedState;
  const surfaceAvailable = enabled && requestedAddress !== null;
  const presentationSource: BrowserSurfacePresentationSource = automationOnly ? "automation" : "panel";
  const responsiveViewportSize =
    viewportState?.mode === "responsive" ? viewportState.confirmed : null;
  const responsiveViewportScale = responsiveViewportSize
    ? calculateViewportPresentationScale(
        responsiveViewportSize,
        fitViewportCanvasBounds(canvasBounds),
        viewportState?.presentation ?? "fit",
      )
    : 1;
  const presentationIntentRef = useRef({
    automationOnly,
    presentationActive,
    presentationSource,
    responsiveViewportSize,
  });
  presentationIntentRef.current = {
    automationOnly,
    presentationActive,
    presentationSource,
    responsiveViewportSize,
  };
  const publishPresentation = useCallback((nextPageState: BrowserSurfacePageState | null): void => {
    const current = presentationIntentRef.current;
    browserSurfacePresentationCoordinator.publish(identity, {
      source: current.presentationSource,
      active: current.automationOnly || current.presentationActive,
      anchor: dockRef.current,
      pageState: nextPageState,
      viewport: current.responsiveViewportSize ?? undefined,
      inputEnabled: !current.automationOnly,
      accessible: !current.automationOnly,
    }, presentationRegistrationRef.current?.token);
  }, [identity]);
  useLayoutEffect(() => {
    if (!surfaceAvailable) return;
    useBrowserAutomationStore.getState().registerTarget(
      identity.workspaceId,
      threadId,
      WEB_RUNTIME_PREVIEW_TAB_ID,
    );
    const initial = browserSurfaceHost.ensure(identity, {
      address: requestedAddressRef.current ?? fixtureUrl,
    });
    const registration = dockRef.current
      ? browserSurfacePresentationCoordinator.registerAnchor(identity, presentationSource, dockRef.current)
      : null;
    presentationRegistrationRef.current = registration;
    setPageState(initial);
    publishPresentation(initial);
    const unsubscribe = browserSurfaceHost.subscribe(identity, (snapshot) => {
      setPageState(snapshot);
      setCrossOriginObserved(snapshot.documentAccess === "cross-origin");
      publishPresentation(snapshot);
    });
    return () => {
      unsubscribe();
      if (presentationRegistrationRef.current === registration) {
        registration?.release();
        presentationRegistrationRef.current = null;
      }
    };
  }, [automationOnly, fixtureUrl, identity, presentationSource, publishPresentation, surfaceAvailable, threadId]);

  useEffect(() => {
    setInputUrl(storedUrl);
    setRequestedAddress(normalizeWebPreviewUrl(storedUrl) ?? fixtureUrl);
    setCrossOriginObserved(false);
  }, [fixtureUrl, storedUrl]);

  useEffect(() => {
    if (!requestedAddress) return;
    const current = browserSurfaceHost.getSnapshot(identity);
    if (!current) return;
    if (
      current.pendingAddress === requestedAddress ||
      current.committedAddress === requestedAddress
    ) return;
    browserSurfaceHost.navigate(identity, requestedAddress);
  }, [identity, requestedAddress]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const update = () => setCanvasBounds({ width: surface.clientWidth, height: surface.clientHeight });
    update();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(surface);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  useLayoutEffect(() => {
    const dock = dockRef.current;
    if (!dock) {
      return;
    }
    const update = (): void => {
      publishPresentation(pageState);
    };
    const resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(update)
      : null;
    resizeObserver?.observe(dock);
    window.addEventListener("resize", update);
    update();
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [automationOnly, identity, pageState, presentationActive, presentationSource, publishPresentation, responsiveViewportScale, responsiveViewportSize, state]);

  const navigate = (candidate = inputUrl): void => {
    const next = normalizeWebPreviewUrl(candidate);
    if (!next) {
      setRequestedAddress(null);
      setCrossOriginObserved(false);
      return;
    }
    setRequestedAddress(next);
    setCrossOriginObserved(false);
    useDiffStore.getState().setPreviewUrlForThread(threadId, next);
  };

  const noOp = (): void => undefined;
  const invalidateViewportObservation = (): void => {
    invalidateBrowserAutomationTargetObservation(identity.workspaceId, threadId, WEB_RUNTIME_PREVIEW_TAB_ID);
  };
  const visiblePageState = surfaceAvailable ? pageState : null;
  const visibleAddress = visiblePageState?.phase === "error"
    ? visiblePageState.pendingAddress ?? visiblePageState.committedAddress
    : visiblePageState?.committedAddress ?? visiblePageState?.pendingAddress ?? requestedAddress;
  const previewContent = state === "same-origin" && requestedAddress ? (
    <div
      ref={dockRef}
      data-testid="web-runtime-preview-dock"
      className="absolute inset-0 h-full w-full"
    />
  ) : state === "cross-origin" && requestedAddress ? (
    <>
      <div
        ref={dockRef}
        data-testid="web-runtime-preview-dock"
        className="absolute inset-0 h-full w-full"
      />
      <div data-testid="web-runtime-cross-origin" className="pointer-events-none absolute inset-x-3 top-3 rounded-md border border-amber-500/40 bg-background/95 px-3 py-2 text-xs text-amber-700 shadow-sm">
        Cross-origin preview is visible, but web automation and DOM access are unsupported.
      </div>
    </>
  ) : (
    <div data-testid={`web-runtime-${state}`} className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
      {state === "disabled"
        ? "Web preview automation is disabled. Set MCODE_WEB_AUTOMATION=1 and restart agent:up to enable it."
        : "Web preview is unavailable until an HTTP(S) same-origin target is loaded."}
    </div>
  );

  return (
    <div data-testid="web-runtime-preview" className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <BrowserHeader
        url={visibleAddress ?? ""}
        pageTitle={visiblePageState?.title || null}
        faviconUrl={visiblePageState?.favicon ?? null}
        hasLoadedPage={Boolean(visibleAddress)}
        canBack={visiblePageState?.navigation?.canGoBack ?? false}
        canFwd={visiblePageState?.navigation?.canGoForward ?? false}
        threadId=""
        designModeActive={false}
        elementPickBusy={false}
        captureBusy={false}
        regionBusy={false}
        onNavigate={(url) => {
          invalidateBrowserAutomationTargetObservation(identity.workspaceId, threadId, WEB_RUNTIME_PREVIEW_TAB_ID);
          setInputUrl(url);
          navigate(url);
        }}
        onGoBack={noOp}
        onGoForward={noOp}
        onReload={() => {
          invalidateBrowserAutomationTargetObservation(identity.workspaceId, threadId, WEB_RUNTIME_PREVIEW_TAB_ID);
          browserSurfaceHost.navigate(identity, visibleAddress ?? fixtureUrl);
        }}
        onOpenExternal={noOp}
        onToggleDesign={noOp}
        onScreenshot={noOp}
        onNewPage={noOp}
        onForceReload={() => {
          invalidateBrowserAutomationTargetObservation(identity.workspaceId, threadId, WEB_RUNTIME_PREVIEW_TAB_ID);
          browserSurfaceHost.navigate(identity, visibleAddress ?? fixtureUrl);
        }}
        onRegionCapture={noOp}
        onDumpContent={noOp}
        onClearCookies={noOp}
        onClearCache={noOp}
        onGetZoom={async () => zoom}
        onSetZoom={async (factor) => {
          const next = Math.min(2, Math.max(0.25, factor));
          setZoom(next);
          return next;
        }}
        onOpenDevTools={noOp}
        onToggleViewportToolbar={onToggleViewportToolbar}
        viewportToolbarVisible={viewportToolbarOpen || responsiveViewportSize !== null}
        onHumanFocus={() => invalidateBrowserAutomationTargetObservation(identity.workspaceId, threadId, WEB_RUNTIME_PREVIEW_TAB_ID)}
      />
      {viewportToolbarOpen || responsiveViewportSize ? (
        viewportCoordinator && viewportState ? (
          <BrowserViewportToolbar
            coordinator={viewportCoordinator}
            state={viewportState}
            scale={responsiveViewportScale}
            onClose={onCloseViewportToolbar}
            onUserViewportChange={invalidateViewportObservation}
          />
        ) : null
      ) : null}
      <div ref={surfaceRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-muted/10">
        <BrowserViewportCanvas
          coordinator={viewportCoordinator}
          state={viewportState}
          bounds={canvasBounds}
          scale={responsiveViewportScale}
          className="absolute inset-0"
          onUserViewportChange={invalidateViewportObservation}
        >
          {previewContent}
        </BrowserViewportCanvas>
      </div>
    </div>
  );
}

/**
 * Embedded site preview: a clean URL header above a region aligned to an
 * BrowserSurfaceHost page. The header morphs across empty, focused, and loaded
 * states; when nothing is loaded the surface lists detected localhost ports as
 * one-click cards. Full viewport, drag-selected region, element-pick PNGs, or
 * fence-only page context attach to the composer. A loading banner sits between
 * the header and guest region. In web-only builds without
 * `desktopBridge.preview`, renders an explanatory empty state.
 */
export function PreviewPanel({
  threadId,
  workspaceId,
  automationOnly = false,
  presentationActive = true,
  coveredLeft,
}: PreviewPanelProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const webviewRefs = useRef<Record<string, PreviewWebviewHandle | null>>({});
  const [viewportCanvasBounds, setViewportCanvasBounds] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const update = () => setViewportCanvasBounds({
      width: surface.clientWidth,
      height: surface.clientHeight,
    });
    update();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(surface);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

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
  // Tracks whether the note input inside the bubble has focus so we can show
  // a subtle ring on the bubble container itself instead of an inner ring on
  // the input (which would conflict with the dark background).
  const [bubbleInputFocused, setBubbleInputFocused] = useState(false);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const bubbleNoteInputRef = useRef<HTMLInputElement | null>(null);

  // Resolve provider + workspace path from the thread row so the autocomplete
  // hooks can load skills scoped to the same context as the Composer.
  const activeThread = useWorkspaceThread(threadId, (t) => t);
  const providerId = (activeThread?.provider ?? undefined) as string | undefined;
  // Slash-command autocomplete for the bubble. Builtins are excluded because
  // mcode app-level actions (plan, compact, goal) have no meaning inside an
  // annotation comment because they target the Composer's thread, not the bubble.
  const bubbleSlashCommand = useSlashCommand({
    anchorRef: bubbleNoteInputRef as React.RefObject<HTMLElement | null>,
    workspaceId: workspaceId ?? undefined,
    threadId,
    providerId,
    includeBuiltins: false,
    includePlugins: false,
  });
  const {
    isOpen: bubbleSlashOpen,
    state: bubbleSlashState,
    items: bubbleSlashItems,
    selectedIndex: bubbleSlashSelectedIndex,
    anchorRect: bubbleSlashAnchorRect,
    onInputChange: onBubbleSlashInputChange,
    onKeyDown: onBubbleSlashKeyDown,
    onSelect: onBubbleSlashSelect,
    onDismiss: dismissBubbleSlash,
    onRetry: retryBubbleSlash,
  } = bubbleSlashCommand;

  // @ file/agent autocomplete for the bubble. Mirrors the Composer's setup;
  // agents only appear when the provider is codex (same gate as Composer).
  const bubbleFileAutocomplete = useFileAutocomplete({
    workspaceId: workspaceId ?? undefined,
    threadId,
    providerId,
  });
  const {
    suggestions: bubbleFileSuggestions,
    query: bubbleFileQuery,
    isOpen: bubbleFileOpen,
    triggerStart: bubbleFileTriggerStart,
    handleInputChange: onBubbleFileInputChange,
    selectSuggestion: selectBubbleFileSuggestion,
    dismiss: dismissBubbleFile,
  } = bubbleFileAutocomplete;

  const handleBubbleMentionSelect = useCallback(
    (item: MentionSuggestion) => {
      selectBubbleFileSuggestion(item);
      const input = bubbleNoteInputRef.current;
      if (!input) return;
      const cursor = input.selectionStart ?? bubbleNote.length;
      const text = bubbleNote;
      // Insert `@<label> ` replacing the typed fragment from the @ trigger to
      // the cursor. This matches the text form Lexical serializes for MentionNode
      // (`@${label}`) so the agent-side parser sees identical content.
      const before = text.slice(0, bubbleFileTriggerStart);
      const after = text.slice(cursor);
      const inserted = `@${item.label} `;
      const next = before + inserted + after;
      // Enforce the maxLength cap before updating state.
      if (next.length <= 4000) {
        setBubbleNote(next);
        setOutsideWarned(false);
        // Restore cursor after state update (one frame later via rAF).
        const nextCursor = before.length + inserted.length;
        window.requestAnimationFrame(() => {
          if (!bubbleNoteInputRef.current) return;
          bubbleNoteInputRef.current.setSelectionRange(nextCursor, nextCursor);
        });
      }
    },
    [bubbleFileTriggerStart, bubbleNote, selectBubbleFileSuggestion],
  );

  const bubbleFilePopup = useFileTagPopup({
    items: bubbleFileSuggestions,
    query: bubbleFileQuery,
    isOpen: bubbleFileOpen,
    onSelect: handleBubbleMentionSelect,
    onDismiss: dismissBubbleFile,
  });

  // Capture the anchor rect when the file popup opens rather than reading it
  // on every render. The bubble can shift (advanced panel expand, scroll) after
  // open, but the popup should stay pinned to where the input was when the
  // trigger fired, consistent with SlashCommandPopup's anchorRect behavior.
  const [filePopupAnchorRect, setFilePopupAnchorRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (bubbleFileOpen) {
      setFilePopupAnchorRect(bubbleNoteInputRef.current?.getBoundingClientRect() ?? null);
    } else {
      setFilePopupAnchorRect(null);
    }
  }, [bubbleFileOpen]);

  // Subscribes the scope's tab set into usePreviewTabsStore and exposes the
  // "New page" action for the header. Page switching/closing is driven from the
  // activity rail (the page switcher), so this panel no longer renders a strip.
  const tabs = usePreviewTabs(threadId, workspaceId);
  const automationControllers = useBrowserAutomationStore((state) => state.controllers);
  const pendingAgentOpens = useBrowserAutomationStore((state) => state.pendingAgentOpens);
  const automationActiveRequests = useBrowserAutomationStore((state) => state.activeRequests);
  const automationLiveTargets = useBrowserAutomationStore((state) => state.liveTargets);
  const automationViewports = useBrowserAutomationStore((state) => state.viewportByTarget);
  const automationViewportStates = useBrowserAutomationStore((state) => state.viewportStateByTarget);
  const automationViewportCoordinators = useBrowserAutomationStore((state) => state.viewportCoordinators);
  const activeWebviewTabId =
    tabs.tabSet?.activeTabId ??
    (window.desktopBridge?.preview
      ? PREVIEW_WEBVIEW_FALLBACK_TAB_ID
      : WEB_RUNTIME_PREVIEW_TAB_ID);
  const browserWorkspaceId = workspaceId ?? threadId;
  const activeBrowserTargetKey = browserAutomationTargetKey(browserWorkspaceId, threadId, activeWebviewTabId);
  const projectedActiveViewportState: ViewportCoordinatorState | undefined =
    automationViewportStates.get(activeBrowserTargetKey);
  const activeViewportCoordinator = automationViewportCoordinators.get(activeBrowserTargetKey);
  const activeViewportState = useLiveViewportCoordinatorState(
    activeViewportCoordinator,
    projectedActiveViewportState,
  );
  const [viewportToolbarOpen, setViewportToolbarOpen] = useState(false);
  useEffect(() => {
    if (window.desktopBridge?.preview) return;
    const target = automationLiveTargets.get(activeBrowserTargetKey);
    if (!target) return;
    getOrCreateViewportCoordinator({
      existing: automationViewportCoordinators.get(activeBrowserTargetKey),
      target,
      initial: automationViewportStates.get(activeBrowserTargetKey)?.confirmed ??
        automationViewports.get(activeBrowserTargetKey) ?? DEFAULT_VIEWPORT_SIZE,
      mode: automationViewportStates.get(activeBrowserTargetKey)?.mode,
      presentation: automationViewportStates.get(activeBrowserTargetKey)?.presentation,
      targetGeneration: target.revision,
      surface: {
        setViewport: (size, operation, coordinator) => useBrowserAutomationStore.getState().applyViewportIfCurrent(
          browserWorkspaceId,
          threadId,
          activeWebviewTabId,
          coordinator,
          operation.targetGeneration,
          size,
        ),
        resetViewport: (operation, coordinator) => useBrowserAutomationStore.getState().resetViewportIfCurrent(
          browserWorkspaceId,
          threadId,
          activeWebviewTabId,
          coordinator,
          operation.targetGeneration,
        ),
        readViewport: () => useBrowserAutomationStore.getState().viewportByTarget.get(activeBrowserTargetKey) ?? null,
        waitForLayout: waitForViewportLayout,
        isCurrent: (operation, coordinator) => {
          const current = useBrowserAutomationStore.getState();
          return current.viewportCoordinators.get(activeBrowserTargetKey) === coordinator &&
            current.liveTargets.get(activeBrowserTargetKey)?.revision === operation.targetGeneration;
        },
      },
      readConfirmed: () => useBrowserAutomationStore.getState().viewportStateByTarget.get(activeBrowserTargetKey)?.confirmed ??
        useBrowserAutomationStore.getState().viewportByTarget.get(activeBrowserTargetKey) ?? null,
      onStateChange: (nextState, coordinator) => useBrowserAutomationStore.getState().setViewportState(
        browserWorkspaceId,
        threadId,
        activeWebviewTabId,
        nextState,
        coordinator,
      ),
      onCreated: (coordinator) => useBrowserAutomationStore.getState().setViewportCoordinator(
        browserWorkspaceId,
        threadId,
        activeWebviewTabId,
        coordinator,
      ),
    });
  }, [
    activeBrowserTargetKey,
    activeWebviewTabId,
    automationLiveTargets,
    automationViewports,
    automationViewportStates,
    automationViewportCoordinators,
    threadId,
    browserWorkspaceId,
  ]);
  const invalidateActiveViewportObservation = useCallback((): void => {
    invalidateBrowserAutomationTargetObservation(browserWorkspaceId, threadId, activeWebviewTabId);
  }, [activeWebviewTabId, browserWorkspaceId, threadId]);
  useEffect(() => {
    if (!viewportToolbarOpen || !activeViewportCoordinator) return;
    let cancelled = false;
    void (async () => {
      await activeViewportCoordinator.requestUserMode("responsive");
      if (!cancelled) await activeViewportCoordinator.setPresentation("fit");
    })();
    return () => {
      cancelled = true;
    };
  }, [activeViewportCoordinator, viewportToolbarOpen]);
  const toggleViewportToolbar = useCallback((): void => {
    const next = !(viewportToolbarOpen || activeViewportState?.mode === "responsive");
    setViewportToolbarOpen(next);
    invalidateActiveViewportObservation();
    if (!next) void activeViewportCoordinator?.requestUserMode("regular");
  }, [activeViewportCoordinator, activeViewportState?.mode, invalidateActiveViewportObservation, viewportToolbarOpen]);
  const closeViewportToolbar = useCallback((): void => {
    void activeViewportCoordinator?.requestUserMode("regular");
    setViewportToolbarOpen(false);
  }, [activeViewportCoordinator]);

  const omniboxFocusTick = usePreviewFocusStore((s) => s.omniboxFocusTick);
  const showWebviewPreview = true;
  const webRuntime = typeof window.desktopBridge?.preview !== "object";

  const bridge = usePreviewBridge({
    threadId,
    workspaceId,
    surfaceRef,
    automationOnly,
  });
  // Keep each mounted webview's requested URL separate from live page chrome.
  // A redirect updates the chrome, but must not rewrite the React `src` prop
  // while the guest is still navigating.
  const [webviewRequestedUrlByTab, setWebviewRequestedUrlByTab] = useState<Record<string, string | null>>(
    () => {
      const initial: Record<string, string | null> = {};
      for (const tab of tabs.tabSet?.tabs ?? []) {
        if (tab.url) initial[tab.id] = tab.url;
      }
      return initial;
    },
  );
  const webviewRequestedUrlRef = useRef<string | null>(null);
  const setWebviewRequestedUrl = useCallback((tabId: string, nextUrl: string | null): void => {
    webviewRequestedUrlRef.current = nextUrl;
    setWebviewRequestedUrlByTab((prev) => (
      (prev[tabId] ?? null) === nextUrl ? prev : { ...prev, [tabId]: nextUrl }
    ));
  }, []);
  useEffect(() => {
    const visibleTabs = tabs.tabSet?.tabs ?? [];
    setWebviewRequestedUrlByTab((current) => {
      let next: Record<string, string | null> | null = null;
      for (const tab of visibleTabs) {
        if (!tab.url || Object.prototype.hasOwnProperty.call(current, tab.id)) continue;
        next ??= { ...current };
        next[tab.id] = tab.url;
      }
      return next ?? current;
    });
  }, [tabs.tabSet?.tabs]);
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
  const activeWebviewTab = tabs.tabSet?.tabs.find(
    (tab) => tab.id === activeWebviewTabId,
  );
  const hydratedWebviewTargetRef = useRef<string | null>(null);
  const activeWebviewTabUrl = activeWebviewTab?.url ?? null;
  const activeWebviewSrc =
    webviewRequestedUrlByTab[activeWebviewTabId] ?? activeWebviewTabUrl;
  const warmWebviewTabs = useMemo(() => {
    const sourceTabs =
      tabs.tabSet?.tabs.length
        ? tabs.tabSet.tabs
        : activeWebviewSrc
          ? [
              {
                id: activeWebviewTabId,
                url: activeWebviewSrc,
              },
            ]
          : webRuntime
            ? [{ id: PREVIEW_WEBVIEW_FALLBACK_TAB_ID, url: "about:blank" }]
            : [];
    const warmIds = selectWarmBrowserTabIds(sourceTabs, browserWorkspaceId, threadId, activeWebviewTabId);
    return sourceTabs
      .filter((tab) => warmIds.has(tab.id))
      .map((tab) => ({
        id: tab.id,
        src: webviewRequestedUrlByTab[tab.id] ?? tab.url ?? "about:blank",
      }));
  }, [
    activeWebviewSrc,
    activeWebviewTabId,
    automationActiveRequests,
    tabs.tabSet,
    threadId,
    browserWorkspaceId,
    webviewRequestedUrlByTab,
    webRuntime,
  ]);
  const activeAutomationController = automationControllers.get(
    browserAutomationTargetKey(browserWorkspaceId, threadId, activeWebviewTabId),
  );
  const activeAutomationRequest = [...automationActiveRequests.values()].find(
    ({ dispatch }) =>
      dispatch.request.workspaceId === browserWorkspaceId &&
      dispatch.target.threadId === threadId && dispatch.target.tabId === activeWebviewTabId,
  );
  const agentControlsBrowser = isBrowserAutomationAgentControlled(
    { controllers: automationControllers, pendingAgentOpens },
    browserWorkspaceId,
    threadId,
    activeWebviewTabId,
  );
  const automationPointer = activeAutomationController?.pointer ?? null;
  const activeWebviewRef = useCallback(
    (): PreviewWebviewHandle | null =>
      webviewRefs.current[activeWebviewTabId] ?? null,
    [activeWebviewTabId],
  );

  useEffect(() => {
    webviewRequestedUrlRef.current = activeWebviewSrc;
  }, [activeWebviewSrc]);

  useEffect(() => {
    if (!showWebviewPreview) return;
    if (!activeWebviewTabUrl) return;
    const active = activeWebviewRef();
    const nextCanBack = active?.canGoBack() ?? false;
    const nextCanFwd = active?.canGoForward() ?? false;
    setWebviewCanBack((value) => (value === nextCanBack ? value : nextCanBack));
    setWebviewCanFwd((value) => (value === nextCanFwd ? value : nextCanFwd));
  }, [
    activeWebviewRef,
    activeWebviewTabUrl,
    showWebviewPreview,
  ]);

  useEffect(() => {
    if (!showWebviewPreview) return;
    if (tabs.tabSet) {
      if (hydratedWebviewTargetRef.current === activeBrowserTargetKey) return;
      hydratedWebviewTargetRef.current = activeBrowserTargetKey;
      const nextStatus: PreviewPageStatus = isEmptyPreviewTabUrl(activeWebviewTabUrl)
        ? { url: null, title: null, favicon: null, phase: "loaded" }
        : {
            url: activeWebviewTabUrl,
            title: activeWebviewTab?.title ?? null,
            favicon: activeWebviewTab?.faviconUrl ?? null,
            phase: "loaded",
          };
      setWebviewPageStatus((status) => (
        status.url === nextStatus.url &&
        status.title === nextStatus.title &&
        status.favicon === nextStatus.favicon &&
        status.phase === nextStatus.phase &&
        status.error === undefined
          ? status
          : nextStatus
      ));
      return;
    }
    hydratedWebviewTargetRef.current = null;
    const stored = bridge.storedUrl.trim();
    if (!stored) {
      setWebviewRequestedUrl(activeWebviewTabId, null);
      setWebviewPageStatus((status) => (
        status.url === null && status.title === null && status.favicon === null &&
        status.phase === "loaded" && status.error === undefined
          ? status
          : { url: null, title: null, favicon: null, phase: "loaded" }
      ));
      return;
    }
    if (activeWebviewRef()?.getUrl() === stored) return;
    if (webviewRequestedUrlRef.current === stored) return;
    setWebviewRequestedUrl(activeWebviewTabId, stored);
  }, [
    activeWebviewRef,
    activeWebviewTab,
    activeWebviewTabUrl,
    activeWebviewTabId,
    bridge.storedUrl,
    setWebviewRequestedUrl,
    showWebviewPreview,
    tabs.tabSet,
    threadId,
  ]);

  const onWebviewPageStatus = useCallback(
    (status: PreviewPageStatus): void => {
      setWebviewPageStatus(status);
      const url = status.url;
      // Title events can arrive without a readable guest URL. They refine the
      // current page and must not erase it, while a titleless null status is an
      // authoritative blank or failed navigation and clears persisted state.
      if (url === null && (status.title !== null || status.phase === "loading")) return;
      const persistedUrl = url === null || url.startsWith("about:") || url.startsWith("chrome-error://")
        ? ""
        : url;
      useDiffStore.getState().setPreviewUrlForThread(threadId, persistedUrl);
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
        const active = activeWebviewRef();
        const liveUrl = active?.getUrl();
        const mountedSrc = webviewRequestedUrlRef.current;
        if (liveUrl === result.url) {
          active?.reload();
          return;
        }
        if (mountedSrc === result.url) {
          active?.navigate(result.url);
          return;
        }
        setWebviewRequestedUrl(activeWebviewTabId, result.url);
      });
    },
    [activeWebviewRef, activeWebviewTabId, bridge, setWebviewRequestedUrl, threadId],
  );

  const onWebviewOpenExternal = useCallback((): void => {
    const url = activeWebviewRef()?.getUrl() || activeWebviewSrc;
    if (url) void window.desktopBridge?.openExternalUrl(url);
  }, [activeWebviewRef, activeWebviewSrc]);

  const onWebviewGetZoom = useCallback(async (): Promise<number> => {
    return (await activeWebviewRef()?.getZoom()) ?? 1;
  }, [activeWebviewRef]);

  const onWebviewSetZoom = useCallback(
    async (factor: number): Promise<number> => {
      return (await activeWebviewRef()?.setZoom(factor)) ?? factor;
    },
    [activeWebviewRef],
  );

  const effectivePageStatus = showWebviewPreview
    ? webviewPageStatus
    : bridge.pageStatus;
  const effectiveInputUrl = showWebviewPreview
    ? (webviewPageStatus.url ?? activeWebviewSrc ?? "")
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
    ? () => activeWebviewRef()?.goBack()
    : bridge.onGoBack;
  const effectiveGoForward = showWebviewPreview
    ? () => activeWebviewRef()?.goForward()
    : bridge.onGoForward;
  const effectiveReload = showWebviewPreview
    ? () => activeWebviewRef()?.reload()
    : bridge.onReload;
  const effectiveForceReload = showWebviewPreview
    ? () => activeWebviewRef()?.forceReload()
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
    usePreviewTabsStore.getState().setLiveChrome(browserWorkspaceId, threadId, {
      title: effectivePageStatus.title,
      url: effectivePageStatus.url,
      favicon: effectivePageStatus.favicon,
    });
  }, [browserWorkspaceId, threadId, effectivePageStatus]);
  useEffect(() => {
    return () => {
      usePreviewTabsStore.getState().setLiveChrome(browserWorkspaceId, threadId, null);
    };
  }, [browserWorkspaceId, threadId]);

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
    // Dismiss any open autocomplete popups so they don't linger after the
    // bubble closes (the hooks' own Escape handling only fires while the input
    // has focus, which it loses when the bubble unmounts).
    dismissBubbleSlash();
    dismissBubbleFile();
  }, [threadId, dismissBubbleSlash, dismissBubbleFile]);

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
      // Exempt the fixed-position slash-command popup because it renders outside the
      // bubble DOM so bubbleRef.contains() misses it, but a click on it should
      // not count as "clicking outside" the bubble.
      if (target instanceof Element && target.closest("[data-slash-popup]")) {
        return;
      }
      // Exempt the file-tag popup because it also renders fixed/outside the bubble
      // DOM when anchorRect is provided, so bubbleRef.contains() misses it.
      if (target instanceof Element && target.closest("[data-file-popup]")) {
        return;
      }
      // Legacy guard for data-file-item in case any row escapes the popup wrapper.
      if (target instanceof Element && target.closest("[data-file-item]")) {
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
    // When an inline autocomplete popup is open inside the bubble (slash
    // command or file mention), Escape must close only that popup, not the
    // bubble itself. The document capture listener fires before the input's
    // React synthetic handler, so we intercept here. Dismissing the popup
    // and returning prevents the capture listener from also closing the bubble.
    if (bubbleSlashOpen) {
      dismissBubbleSlash();
      return;
    }
    if (bubbleFileOpen) {
      dismissBubbleFile();
      return;
    }
    if (hasOpenBubble) {
      closeOpenAnnotationBubble();
      return;
    }
    closeOpenAnnotationBubble();
    designModeSetActive(threadId, false);
    void window.desktopBridge?.preview?.cancelCapture();
  }, [
    bubbleSlashOpen,
    bubbleFileOpen,
    closeOpenAnnotationBubble,
    designModeSetActive,
    dismissBubbleSlash,
    dismissBubbleFile,
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

  const hasDesktopPreview = !!window.desktopBridge?.preview;
  const webRuntimeEnabled = isBrowserAutomationWebRuntimeEnabled();
  if (!hasDesktopPreview && webRuntimeEnabled) {
    return (
      <WebRuntimePreview
        key={threadId}
        threadId={threadId}
        workspaceId={workspaceId}
        viewportCoordinator={activeViewportCoordinator}
        viewportState={activeViewportState}
        viewportToolbarOpen={viewportToolbarOpen}
        onToggleViewportToolbar={toggleViewportToolbar}
        onCloseViewportToolbar={closeViewportToolbar}
        automationOnly={automationOnly}
        presentationActive={presentationActive}
      />
    );
  }
  if (!hasDesktopPreview) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground"
        data-testid="preview-panel-unavailable"
      >
        <Globe className="size-8 opacity-50" aria-hidden />
        <p className="max-w-xs text-balance">
          Web preview automation is disabled. Set MCODE_WEB_AUTOMATION=1 and
          restart agent:up to enable the same-origin Browser preview.
        </p>
      </div>
    );
  }

  const hasLoadedPage = showWebviewPreview
    ? !isEmptyPreviewTabUrl(activeWebviewSrc ?? webviewPageStatus.url)
    : bridge.storedUrl.trim().length > 0;
  const pageError =
    effectivePageStatus.phase === "error"
      ? effectivePageStatus.error
      : undefined;
  const showLocalPorts =
    !hasLoadedPage && !effectivePreviewLoading && !pageError;
  const hasWebviewLayer = showWebviewPreview && warmWebviewTabs.length > 0;
  const webviewLayerInteractive = hasWebviewLayer && !showLocalPorts && !pageError;
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
    // When either autocomplete popup is open, delegate navigation keys to it
    // before falling through to the save logic. Escape must close the popup
    // only. It must NOT close/discard the bubble itself.
    if (bubbleFileOpen) {
      const handled = bubbleFilePopup.handleKeyDown(event);
      if (handled) return;
    }

    if (bubbleSlashOpen) {
      // Arrow + Escape are handled by the hook's own onKeyDown.
      onBubbleSlashKeyDown(event);
      if (event.isDefaultPrevented()) return;

      // Enter/Tab select the highlighted command.
      if (event.key === "Enter" || event.key === "Tab") {
        const cmd = bubbleSlashItems[bubbleSlashSelectedIndex];
        if (cmd) {
          event.preventDefault();
          event.stopPropagation();
          onBubbleSlashSelect(cmd, (next) => {
            if (next.length <= 4000) {
              setBubbleNote(next);
              setOutsideWarned(false);
              // Restore cursor after the slash trigger + command name.
              const input = bubbleNoteInputRef.current;
              if (input) {
                window.requestAnimationFrame(() => {
                  input.setSelectionRange(next.length, next.length);
                });
              }
            }
          });
          return;
        }
      }
      return;
    }

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
  const responsiveViewportSize =
    activeViewportState?.mode === "responsive" ? activeViewportState.confirmed : null;
  const responsiveViewportScale = responsiveViewportSize
    ? calculateViewportPresentationScale(
        responsiveViewportSize,
        fitViewportCanvasBounds(viewportCanvasBounds),
        activeViewportState?.presentation ?? "fit",
      )
    : 1;
  const warmWebviewLayer = warmWebviewTabs.map((tab) => {
    const tabKey = browserAutomationTargetKey(browserWorkspaceId, threadId, tab.id);
    const tabViewport = automationViewports.get(tabKey);
    const tabViewportState = automationViewportStates.get(tabKey);
    return (
      <PreviewWebview
        key={tab.id}
        active={automationOnly || (tab.id === activeWebviewTabId && webviewLayerInteractive)}
        ref={(handle) => {
          webviewRefs.current[tab.id] = handle;
        }}
        threadId={threadId}
        workspaceId={workspaceId ?? threadId}
        tabId={tab.id}
        src={tab.src}
        allowHiddenPresentation={automationOnly}
        presentationActive={automationOnly || presentationActive}
        presentationSource={automationOnly ? "automation" : "panel"}
        coveredLeft={coveredLeft}
        viewport={tabViewportState?.mode === "responsive" ? tabViewport : undefined}
        className={cn(
          responsiveViewportSize
            ? "absolute left-0 top-0"
            : "absolute inset-0 h-full w-full",
          tab.id === activeWebviewTabId
            ? "z-0 block"
            : "pointer-events-none -z-10 opacity-0",
        )}
        onPageStatus={(status) => {
          usePreviewTabsStore.getState().updateTabChrome(browserWorkspaceId, threadId, tab.id, {
            title: status.title,
            url: status.url,
            favicon: status.favicon,
          });
          if (tab.id !== activeWebviewTabId) return;
          onWebviewPageStatus(status);
        }}
        onNavigationStateChange={(state) => {
          if (tab.id !== activeWebviewTabId) return;
          setWebviewCanBack(state.canGoBack);
          setWebviewCanFwd(state.canGoForward);
        }}
      />
    );
  });

  return (
    <div
      data-testid="preview-panel"
      className="flex h-full min-h-0 min-w-0 flex-1 basis-0 flex-col overflow-hidden"
    >
      <div
        className={cn(showWebviewPreview && "relative z-20")}
        style={coveredLeft ? { clipPath: `inset(0 0 0 ${coveredLeft}px)` } : undefined}
      >
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
            onNavigate={(url) => {
              invalidateBrowserAutomationTargetObservation(browserWorkspaceId, threadId, activeWebviewTabId);
              effectiveNavigate(url);
            }}
            onGoBack={() => {
              invalidateBrowserAutomationTargetObservation(browserWorkspaceId, threadId, activeWebviewTabId);
              effectiveGoBack();
            }}
            onGoForward={() => {
              invalidateBrowserAutomationTargetObservation(browserWorkspaceId, threadId, activeWebviewTabId);
              effectiveGoForward();
            }}
            onReload={() => {
              invalidateBrowserAutomationTargetObservation(browserWorkspaceId, threadId, activeWebviewTabId);
              effectiveReload();
            }}
            onOpenExternal={effectiveOpenExternal}
            onToggleDesign={onToggleDesignMode}
            onScreenshot={capture.onAddPictureReference}
            onNewPage={() => {
              invalidateBrowserAutomationTargetObservation(browserWorkspaceId, threadId, activeWebviewTabId);
              tabs.newTab();
            }}
            onForceReload={() => {
              invalidateBrowserAutomationTargetObservation(browserWorkspaceId, threadId, activeWebviewTabId);
              effectiveForceReload();
            }}
            onRegionCapture={capture.onAddRegionPictureReference}
            onDumpContent={capture.onAddPageContextOnly}
            onClearCookies={bridge.onClearCookies}
            onClearCache={bridge.onClearCache}
            onGetZoom={effectiveGetZoom}
            onSetZoom={effectiveSetZoom}
            onOpenDevTools={() => {
              void window.desktopBridge?.preview.openGuestDevTools({
                threadId,
                tabId: activeWebviewTabId,
              });
            }}
            onToggleViewportToolbar={toggleViewportToolbar}
            viewportToolbarVisible={viewportToolbarOpen || activeViewportState?.mode === "responsive"}
            automationController={activeAutomationController ?? null}
            automationBusy={activeAutomationRequest !== undefined}
            onHumanFocus={() => {
              if (activeAutomationController?.controller !== "agent") return;
              invalidateBrowserAutomationTargetObservation(browserWorkspaceId, threadId, activeWebviewTabId);
            }}
            onStopAutomation={() =>
              interruptBrowserAutomationTarget(
                browserWorkspaceId,
                threadId,
                activeWebviewTabId,
                "user-stopped",
              )
            }
          />
        )}
        {viewportToolbarOpen || activeViewportState?.mode === "responsive" ? (
          activeViewportCoordinator && activeViewportState ? (
            <BrowserViewportToolbar
              coordinator={activeViewportCoordinator}
              state={activeViewportState}
              scale={responsiveViewportScale}
              onClose={closeViewportToolbar}
              onUserViewportChange={invalidateActiveViewportObservation}
            />
          ) : null
        ) : null}
      </div>

      {effectiveNavError ? (
        <p
          className="flex-none px-3 py-1 text-xs text-destructive"
          role="status"
        >
          {effectiveNavError}
        </p>
      ) : null}

      {/* Surface aligned to the hosted Browser page. */}
      <div
        ref={surfaceRef}
        role="region"
        aria-label="Page preview"
        data-testid="preview-surface"
        className={cn(
          "relative min-h-[min(40vh,20rem)] min-w-0 flex-1 basis-0",
          showWebviewPreview
            ? cn(
                "z-0 rounded-tl-md",
                responsiveViewportSize ? "overflow-auto bg-muted/20" : "overflow-hidden",
              )
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
              // The opaque background keeps the status legible over any page.
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
        {hasWebviewLayer ? (
          <div
            data-testid="preview-webview-surface"
            className={cn(
              "absolute inset-0 z-0 overflow-hidden rounded-tl-md",
              !webviewLayerInteractive && "pointer-events-none",
            )}
          >
          <BrowserViewportCanvas
            coordinator={activeViewportCoordinator}
            state={activeViewportState}
            bounds={viewportCanvasBounds}
            scale={responsiveViewportScale}
            className="absolute inset-0"
            onUserViewportChange={invalidateActiveViewportObservation}
          >
            {warmWebviewLayer}
          </BrowserViewportCanvas>
          </div>
        ) : null}
        {agentControlsBrowser ? (
          <div
            data-testid="browser-automation-overlay"
            className="pointer-events-none absolute inset-0 z-20 rounded-tl-md"
            style={{
              clipPath: coveredLeft ? `inset(0 0 0 ${coveredLeft}px)` : undefined,
              backgroundImage: [
                "linear-gradient(to right, color-mix(in oklab, var(--primary) 26%, transparent), transparent 32px)",
                "linear-gradient(to left, color-mix(in oklab, var(--primary) 26%, transparent), transparent 32px)",
                "linear-gradient(to bottom, color-mix(in oklab, var(--primary) 26%, transparent), transparent 32px)",
                "linear-gradient(to top, color-mix(in oklab, var(--primary) 26%, transparent), transparent 32px)",
              ].join(", "),
              boxShadow: [
                "inset 0 0 40px color-mix(in oklab, var(--primary) 30%, transparent)",
                "0 0 24px color-mix(in oklab, var(--primary) 28%, transparent)",
              ].join(", "),
            }}
          >
            <span className="sr-only" role="status" aria-live="polite">
              Agent controls Browser
            </span>
            <MousePointer2
              data-testid="browser-automation-pointer"
              className="absolute size-5 fill-primary text-primary motion-reduce:transition-none"
              style={{
                left: automationPointer?.x ?? 24,
                top: automationPointer?.y ?? 24,
                filter: "drop-shadow(0 0 5px color-mix(in oklab, var(--primary) 72%, transparent)) drop-shadow(0 2px 5px rgb(0 0 0 / 0.35))",
              }}
              aria-hidden
            />
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
                className="max-w-72 flex-col items-start gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-neutral-100 shadow-xl"
                style={
                  {
                    backgroundColor: BUBBLE_SURFACE_INSET,
                    // Arrow color is set via CSS variable on this element
                    "--tooltip-arrow-bg": BUBBLE_SURFACE_INSET,
                  } as React.CSSProperties
                }
                arrowClassName="fill-[#202020]"
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
              // overflow-hidden clips the rounded corners against child backgrounds;
              // the bubble is intentionally dark (BUBBLE_SURFACE) so it stays
              // readable over any user webpage regardless of the app theme.
              "absolute z-30 w-[min(20.5rem,calc(100%-1rem))] overflow-hidden rounded-[1.55rem] border shadow-xl transition-[border-color,box-shadow] duration-150",
              outsideWarned
                ? "animate-preview-annotation-shake border-destructive/80"
                : bubbleInputFocused
                  ? "border-white/25 ring-1 ring-white/15"
                  : "border-white/10 ring-1 ring-black/20",
              bubbleAdvancedOpen ? "max-h-[20.5rem]" : "min-h-11",
            )}
            style={{
              ...annotationBubbleStyle(
                visibleOpenBubbleBase.bounds,
                previewSurfaceWidth,
              ),
              backgroundColor: BUBBLE_SURFACE,
              color: "rgb(250 250 250)", // neutral-50
            }}
          >
            <div className="flex min-h-11 items-center gap-2 px-3 py-1.5">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className={cn(
                  "shrink-0 rounded-full text-neutral-300 hover:bg-white/10 hover:text-white",
                  bubbleAdvancedOpen && "bg-white/10 text-white",
                )}
                data-testid="preview-annotation-advanced-toggle"
                aria-label="Open annotation visual controls"
                aria-expanded={bubbleAdvancedOpen}
                onClick={() => setBubbleAdvancedOpen((value) => !value)}
              >
                <SlidersHorizontal size={15} aria-hidden />
              </Button>
              {/* No relative wrapper needed because FileTagPopup now uses fixed
                  positioning via anchorRect, escaping the overflow-hidden bubble. */}
              <Input
                ref={bubbleNoteInputRef}
                value={bubbleNote}
                onChange={(event) => {
                  const { value, selectionStart } = event.target;
                  setBubbleNote(value);
                  setOutsideWarned(false);
                  const cursor = selectionStart ?? value.length;
                  // Notify slash-command hook first; if it opens, dismiss the
                  // file autocomplete so both popups never show simultaneously.
                  onBubbleSlashInputChange(value, cursor);
                  onBubbleFileInputChange(value, cursor);
                }}
                onKeyDown={onBubbleNoteKeyDown}
                onFocus={() => setBubbleInputFocused(true)}
                onBlur={() => setBubbleInputFocused(false)}
                className="h-7 min-w-0 flex-1 border-0 bg-transparent px-0 text-sm text-neutral-50 shadow-none outline-none placeholder:text-neutral-500 focus-visible:ring-0"
                maxLength={4000}
                placeholder="Comment · / for skills · @ to mention"
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
                className="border-t border-white/[0.08]"
                style={{ backgroundColor: BUBBLE_SURFACE_INSET }}
              >
                <div
                  className="flex items-center justify-between border-b border-white/[0.08] bg-white/[0.04] px-4 py-1.5 text-xs text-neutral-200"
                >
                  <span className="max-w-[15rem] truncate font-semibold leading-5">
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
                {/* scrollbar-color derives from the unified palette, lighter
                    than the surface by ~30 lightness points so it stays subtle
                    on dark backgrounds without being invisible. */}
                <div className="max-h-52 overflow-y-auto px-4 py-2 [scrollbar-color:rgb(90_90_90)_transparent] [scrollbar-width:thin]">
                  <div className="space-y-2">
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
              <div
                className="flex items-center justify-between border-t border-white/[0.08] px-3 py-2"
                style={{ backgroundColor: BUBBLE_SURFACE_INSET }}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-full text-neutral-300 hover:bg-red-500/[0.18] hover:text-red-100"
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
                    className="h-7 rounded-full px-3 text-neutral-100 hover:bg-white/[0.08] hover:text-white"
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
                    className="h-7 rounded-full bg-neutral-200 px-3 text-neutral-950 hover:bg-white disabled:bg-neutral-500/40 disabled:text-neutral-300"
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
        {/* Both autocomplete popups render outside the bubble div (fixed
            position) so they can escape its overflow-hidden container. */}
        <SlashCommandPopup
          state={bubbleSlashState}
          selectedIndex={bubbleSlashSelectedIndex}
          anchorRect={bubbleSlashAnchorRect}
          onSelect={(cmd: Command) => {
            onBubbleSlashSelect(cmd, (next) => {
              if (next.length <= 4000) {
                setBubbleNote(next);
                setOutsideWarned(false);
                const input = bubbleNoteInputRef.current;
                if (input) {
                  window.requestAnimationFrame(() => {
                    input.setSelectionRange(next.length, next.length);
                  });
                }
              }
            });
          }}
          onDismiss={dismissBubbleSlash}
          onRetry={retryBubbleSlash}
          tone="dark"
        />
        <FileTagPopup
          items={bubbleFileSuggestions}
          isOpen={bubbleFileOpen}
          onSelect={handleBubbleMentionSelect}
          listRef={bubbleFilePopup.listRef}
          selectedIndex={bubbleFilePopup.selectedIndex}
          anchorRect={filePopupAnchorRect}
          tone="dark"
        />
        {pageError ? (
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
