import { app } from "electron";
import * as NodePath from "node:path";

/** Return the platform-specific icon path for a desktop window. */
export function getWindowIconPath(platform: NodeJS.Platform): string {
  const iconFile =
    platform === "win32"
      ? "icon.ico"
      : platform === "darwin"
        ? "icon.icns"
        : "icon.png";
  if (app.isPackaged) {
    return NodePath.join(process.resourcesPath, iconFile);
  }
  return NodePath.join(app.getAppPath(), "build", iconFile);
}
