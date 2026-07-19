const RAW_FILE_CONTENT_KEYS = new Set([
  "_mcodeFileMutations",
  "beforeText",
  "afterText",
  "before_text",
  "after_text",
  "old_string",
  "new_string",
  "oldText",
  "newText",
  "old_text",
  "new_text",
  "content",
  "patch",
  "replacement",
]);

const FILE_OPERATION_TOOLS = new Set([
  "edit",
  "write",
  "delete",
  "remove",
  "create",
  "move",
  "rename",
  "apply_patch",
  "strreplace",
  "searchreplace",
  "file_change",
]);

const SAFE_FILE_METADATA_KEYS = new Set([
  "file_path",
  "filePath",
  "target_file",
  "targetFile",
  "path",
  "oldPath",
  "old_path",
  "old_file_path",
  "oldFilePath",
  "sourcePath",
  "source_path",
  "source",
  "from",
  "newPath",
  "new_path",
  "destinationPath",
  "destination_path",
  "destination",
  "to",
  "operation",
  "operationType",
  "operation_type",
  "kind",
]);

const FILE_PATH_KEYS = new Set([
  "file_path",
  "filePath",
  "target_file",
  "targetFile",
  "path",
  "oldPath",
  "old_path",
  "old_file_path",
  "oldFilePath",
  "sourcePath",
  "source_path",
  "source",
  "from",
  "newPath",
  "new_path",
  "destinationPath",
  "destination_path",
  "destination",
  "to",
]);

const FILE_SOURCE_PATH_KEYS = [
  "oldPath",
  "old_path",
  "old_file_path",
  "oldFilePath",
  "sourcePath",
  "source_path",
  "source",
  "from",
] as const;

const FILE_DESTINATION_PATH_KEYS = [
  "file_path",
  "filePath",
  "target_file",
  "targetFile",
  "path",
  "newPath",
  "new_path",
  "destinationPath",
  "destination_path",
  "destination",
  "to",
] as const;

/** Remove raw file bodies while preserving path and operation metadata for the timeline. */
export function sanitizePublicToolInput(
  input: Record<string, unknown>,
  toolName?: string,
): Record<string, unknown> {
  const normalized = toolName?.toLowerCase();
  const explicitFileTool = normalized != null && FILE_OPERATION_TOOLS.has(normalized);
  const sourceDestinationShapedInput = FILE_SOURCE_PATH_KEYS.some((key) => key in input)
    && FILE_DESTINATION_PATH_KEYS.some((key) => key in input);
  const fileShapedInput = "_mcodeFileMutations" in input
    || sourceDestinationShapedInput
    || ([...FILE_PATH_KEYS].some((key) => key in input)
      && [...RAW_FILE_CONTENT_KEYS].some((key) => key in input));
  if (!explicitFileTool && !fileShapedInput) return input;
  return Object.fromEntries(
    Object.entries(input).filter(([key, value]) =>
      SAFE_FILE_METADATA_KEYS.has(key)
      && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")),
  );
}
