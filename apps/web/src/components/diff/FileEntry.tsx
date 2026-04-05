import { useDiffStore, type SelectedFile } from "@/stores/diffStore";

/** Props for FileEntry. */
interface FileEntryProps {
  filePath: string;
  source: SelectedFile["source"];
  id: string;
}

/** Extract the basename from a file path. */
function getFileBasename(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

/** Extract the immediate parent directory name from a file path. */
function getParentDir(filePath: string): string {
  const parts = filePath.split("/");
  return parts.length > 1 ? parts[parts.length - 2] : "";
}

/** Get the file extension (lowercase, no dot). */
function getExtension(filePath: string): string {
  const basename = getFileBasename(filePath);
  const dot = basename.lastIndexOf(".");
  return dot >= 0 ? basename.slice(dot + 1).toLowerCase() : "";
}

const EXT_COLORS: Record<string, string> = {
  ts: "text-blue-400/60",
  tsx: "text-sky-400/60",
  js: "text-yellow-400/60",
  jsx: "text-yellow-400/60",
  mjs: "text-yellow-400/60",
  cjs: "text-yellow-400/60",
  json: "text-orange-400/60",
  css: "text-pink-400/60",
  scss: "text-pink-400/60",
  md: "text-slate-400/60",
  mdx: "text-slate-400/60",
  py: "text-green-400/60",
  go: "text-cyan-400/60",
  rs: "text-orange-500/60",
  sql: "text-purple-400/60",
  sh: "text-emerald-400/60",
  yaml: "text-amber-400/60",
  yml: "text-amber-400/60",
  toml: "text-amber-400/60",
};

/** Single file row. Click selects the file for diff viewing. */
export function FileEntry({ filePath, source, id }: FileEntryProps) {
  const selectedFile = useDiffStore((s) => s.selectedFile);
  const selectFile = useDiffStore((s) => s.selectFile);

  const isSelected =
    selectedFile?.filePath === filePath &&
    selectedFile?.id === id &&
    selectedFile?.source === source;

  const basename = getFileBasename(filePath);
  const parent = getParentDir(filePath);
  const ext = getExtension(filePath);
  const extColor = EXT_COLORS[ext] ?? "text-muted-foreground/30";

  return (
    <button
      type="button"
      onClick={() => selectFile({ source, id, filePath })}
      className={`group relative flex w-full items-center gap-2 py-[5px] pl-7 pr-3 text-left transition-colors ${
        isSelected
          ? "bg-primary/8 text-foreground"
          : "text-muted-foreground hover:bg-muted/20 hover:text-foreground/80"
      }`}
      title={filePath}
    >
      {/* Selected left border */}
      {isSelected && (
        <span className="absolute left-0 top-0 bottom-0 w-0.5 rounded-r bg-primary/50" />
      )}

      {/* Change status dot */}
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400/50" />

      {/* Name + parent dir */}
      <span className="flex-1 min-w-0">
        <span className="block truncate font-mono text-[11px]">{basename}</span>
        {parent && (
          <span className="block truncate font-mono text-[9px] text-muted-foreground/30">
            {parent}/
          </span>
        )}
      </span>

      {/* Extension badge */}
      {ext && (
        <span className={`shrink-0 font-mono text-[9px] uppercase tracking-wide ${extColor}`}>
          {ext}
        </span>
      )}
    </button>
  );
}
