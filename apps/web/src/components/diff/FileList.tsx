import { FileEntry } from "./FileEntry";
import type { SelectedFile } from "@/stores/diffStore";

/** Props for FileList. */
interface FileListProps {
  files: string[];
  source: SelectedFile["source"];
  id: string;
}

/** List of file entries for a given turn or commit. */
export function FileList({ files, source, id }: FileListProps) {
  if (files.length === 0) {
    return (
      <p className="px-3 py-1 text-[11px] text-muted-foreground/40">No files changed</p>
    );
  }

  return (
    <div className="flex flex-col">
      {files.map((filePath) => (
        <FileEntry key={filePath} filePath={filePath} source={source} id={id} />
      ))}
    </div>
  );
}
