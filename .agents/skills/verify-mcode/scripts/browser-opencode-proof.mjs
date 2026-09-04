#!/usr/bin/env bun
/**
 * Browser proof for OpenCode turns through the owned Electron app.
 *
 * Follows the thread-lifecycle verifier pattern: an agent-owned Electron
 * session via the electorn-live-testing launcher, accessible locators,
 * evidence screenshots, and desktop-socket cleanup of the created thread.
 *
 * Prerequisites: a healthy agent runtime, the Playwright scratch install
 * (electorn-live-testing ensure-playwright), and OpenCode enabled in
 * Settings > Providers.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { openDesktop, openDesktopSocket } from "./thread-lifecycle.mjs";

const SESSION_FILE = "electron-opencode-proof.json";
const MODEL_BUTTON = "GPT-5.6 Luna";

function printHelp() {
  console.log(`browser-opencode-proof.mjs [--model <fragment>] [--prompt <text>] [--expect <text>] [--keep-thread]

Options default to the Muse Spark 1.3 Free model and a one-word reply prompt.`);
}

function parseArgs(argv) {
  const args = { model: "Muse Spark 1.3", prompt: "Reply with exactly:uitest. Nothing else.", expect: "uitest", keepThread: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--help") { printHelp(); process.exit(0); }
    else if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--prompt") args.prompt = argv[++i];
    else if (argv[i] === "--expect") args.expect = argv[++i];
    else if (argv[i] === "--keep-thread") args.keepThread = true;
  }
  return args;
}

async function fixtureThreads(socket, workspaceId) {
  const threads = await socket.rpc("thread.list", { workspaceId });
  return Array.isArray(threads) ? threads.map((t) => t.id) : [];
}

/** Enable OpenCode in the Electron profile through its own runtime. */
async function enableOpenCodeProvider(socket) {
  const settings = await socket.rpc("settings.update", { provider: { enabled: { opencode: true } } });
  if (settings?.provider?.enabled?.opencode !== true) {
    throw new Error("OpenCode did not enable in the Electron profile");
  }
}

/**
 * Stop the owned Electron tree without disconnecting Playwright first:
 * closing the CDP browser tears the tree down early and leaves the stop
 * helper nothing but reaped children to choke on.
 */
async function stopOwnedElectron(repoRoot) {
  const skillFile = NodePath.join(repoRoot, ".agents", "skills", "electorn-live-testing", "scripts", "stop-electron.mjs");
  const { stopElectron } = await import(NodeURL.pathToFileURL(skillFile).href);
  const result = stopElectron(repoRoot, { sessionFileName: SESSION_FILE });
  if (!["stopped", "already-stopped", "not-running"].includes(result.status)) {
    throw new Error(`Unexpected Electron stop status: ${result.status}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = NodePath.resolve(import.meta.dir, "..", "..", "..", "..");
  const evidenceDirectory = NodePath.join(repoRoot, ".dev", "verification", "agent-runtime");
  NodeFS.mkdirSync(evidenceDirectory, { recursive: true });

  let desktop = null;
  let socket = null;
  try {
    desktop = await openDesktop(repoRoot, SESSION_FILE);
    const page = desktop.page;
    socket = await openDesktopSocket(repoRoot, desktop.runtimeDirectory);

    const workspaces = await socket.rpc("workspace.list", {});
    const fixture = workspaces.find((w) => w.name === "fixture-repo");
    if (!fixture) throw new Error("The fixture-repo workspace is missing");
    const before = new Set(await fixtureThreads(socket, fixture.id));

    await page.getByText("Choose project").click();
    await page.getByRole("option", { name: "fixture-repo" }).click();
    await enableOpenCodeProvider(socket);
    await page.getByRole("button", { name: MODEL_BUTTON }).first().click();
    const dialog = page.locator("[role=dialog]").last();
    await page.getByRole("button", { name: "OpenCode" }).first().click();
    const modelButton = dialog.getByRole("button", { name: new RegExp(`Select ${args.model}`) }).first();
    await modelButton.waitFor({ state: "visible", timeout: 30_000 });
    await modelButton.click();

    const box = page.locator("[role=textbox]").last();
    await box.click();
    await box.fill(args.prompt);
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      (expect) => [...document.querySelectorAll("main [data-message-role=assistant]")]
        .some((el) => el.innerText.split("\n").some((line) => line.trim() === expect)),
      args.expect,
      { timeout: 240_000 },
    );
    await page.waitForTimeout(2000);
    await page.screenshot({ path: NodePath.join(evidenceDirectory, "browser-opencode-proof.png") });

    const bubbles = await page.locator("main [data-message-role=assistant]").allInnerTexts();
    const exact = bubbles.filter((t) => t.split("\n").some((line) => line.trim() === args.expect));
    console.log(JSON.stringify({ assistantBubbles: bubbles.length, exactReplies: exact.length }));
    if (exact.length === 0) throw new Error("The assistant reply did not settle with the expected text");

    if (!args.keepThread) {
      const after = await fixtureThreads(socket, fixture.id);
      for (const id of after.filter((id) => !before.has(id))) {
        await socket.rpc("thread.delete", { threadId: id, cleanupWorktree: false });
        console.log(JSON.stringify({ cleanup: id }));
      }
    }
  } catch (error) {
    if (desktop) {
      await desktop.page.screenshot({ path: NodePath.join(evidenceDirectory, "browser-opencode-failure.png") }).catch(() => {});
    }
    throw error;
  } finally {
    await socket?.close().catch(() => {});
    await stopOwnedElectron(repoRoot);
  }
}

await main();
