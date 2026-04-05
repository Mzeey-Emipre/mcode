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

/** Single file row. Click selects the file for diff viewing. */
export function FileEntry({ filePath, source, id }: FileEntryProps) {
  const selectedFile = useDiffStore((s) => s.selectedFile);
  const selectFile = useDiffStore((s) => s.selectFile);

  const isSelected =
    selectedFile?.filePath === filePath &&
    selectedFile?.id === id &&
    selectedFile?.source === source;

  return (
    <button
      type="button"
      onClick={() => selectFile({ source, id, filePath })}
      className={`flex w-full items-center gap-2 px-3 py-1 text-left text-[11px] font-mono transition-colors ${
        isSelected
          ? "bg-primary/10 text-foreground"
          : "text-muted-foreground hover:bg-muted/30 hover:text-foreground/80"
      }`}
      title={filePath}
    >
      <span className="truncate">{getFileBasename(filePath)}</span>
    </button>
  );
}
