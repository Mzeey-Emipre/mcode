/**
 * Core types for the Open-in app registry. Each openable app (editor, file
 * manager, and later terminals / git GUIs) is modeled as an {@link OpenInAdapter}
 * that owns its own detection and launch behavior, so adding an app is a single
 * registration rather than an edit spread across the IPC allowlist and the
 * renderer's config maps.
 */

/**
 * The category of an openable app. Drives launch semantics and how the renderer
 * groups apps in the menu. `editor` opens a file/folder, `gitGui` opens a
 * repository, `terminal` opens a shell at the working directory, `fileManager`
 * reveals a path in the OS file browser.
 */
export type OpenInAppKind = "editor" | "gitGui" | "terminal" | "fileManager";

/**
 * Serializable metadata for an openable app. This is the shape the renderer
 * reads (over IPC) to render menu entries, so it carries no functions — icons
 * are referenced by {@link OpenInAppMeta.iconKey} and resolved to a component on
 * the renderer side.
 */
export interface OpenInAppMeta {
  /** Stable identifier used to dispatch launches (e.g. "code", "explorer"). */
  readonly id: string;
  /** Human-readable name shown in the menu (e.g. "VS Code"). */
  readonly label: string;
  /** App category, driving launch semantics and menu grouping. */
  readonly kind: OpenInAppKind;
  /** Renderer-side key for the app's icon component (icons can't cross IPC). */
  readonly iconKey: string;
}

/**
 * What to open. `line` is honored only by editors with a file target; other
 * adapters ignore it.
 */
export interface LaunchTarget {
  /** Absolute path to open (file or directory). */
  readonly path: string;
  /** Optional 1-based line to jump to (editor + file target only). */
  readonly line?: number;
}

/**
 * An openable app: its metadata plus the two behaviors that used to be branched
 * inline at the call site — detection and launch.
 */
export interface OpenInAdapter extends OpenInAppMeta {
  /** Whether the app is installed / available on this system. */
  detect(): boolean;
  /** Launch the app at the given target. Rejects if the launch fails. */
  launch(target: LaunchTarget): Promise<void>;
}
