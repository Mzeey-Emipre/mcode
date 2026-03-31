/**
 * Bootstrap entry for Electron utilityProcess.
 *
 * utilityProcess.fork() does not process execArgv as Node.js CLI flags
 * and Electron strips NODE_OPTIONS in utility processes, so --import tsx
 * cannot be used. Instead, we use tsx's programmatic ESM API to register
 * the TypeScript loader, then dynamically import the server entry point.
 */
import { register } from "tsx/esm/api";

register();

await import("./index.ts");
