import { app } from "electron";
import { join } from "path";

/** Return the platform-specific icon path for a desktop window. */
export function getWindowIconPath(): string {
  const iconFile =
    process.platform === "win32"
      ? "icon.ico"
      : process.platform === "darwin"
        ? "icon.icns"
        : "icon.png";
  if (app.isPackaged) {
    return join(process.resourcesPath, iconFile);
  }
  return join(app.getAppPath(), "build", iconFile);
}
