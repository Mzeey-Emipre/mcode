import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareSdkPlatformPackages } from "./ensure-sdk-platform-packages.mjs";

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await prepareSdkPlatformPackages();
}
