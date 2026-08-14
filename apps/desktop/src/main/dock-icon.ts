/** Return whether the main process should set a custom macOS dock icon. */
export function shouldSetDockIcon(
  platform: NodeJS.Platform,
  isPackaged: boolean,
): boolean {
  return platform === "darwin" && !isPackaged;
}
