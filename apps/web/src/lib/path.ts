/** Extract the file name from a path (browser-safe, handles both / and \). */
export function basename(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || filePath;
}
