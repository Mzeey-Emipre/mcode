import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SESSION_FILE_NAME = "electron-live-testing.json";

/** Connects Playwright to the Electron process owned by start-electron.mjs. */
export async function connectElectronSession({ playwright, repoRoot }) {
  if (!playwright?.chromium?.connectOverCDP) {
    throw new Error("Pass the module returned by await import(\"playwright\")");
  }
  if (typeof repoRoot !== "string" || repoRoot.trim().length === 0) {
    throw new Error("Pass the repository root from nodeRepl.cwd");
  }

  const root = resolve(repoRoot);
  const sessionFile = join(root, ".dev", SESSION_FILE_NAME);
  if (!existsSync(sessionFile)) {
    throw new Error("Run start-electron.mjs before connecting Playwright");
  }
  const record = JSON.parse(readFileSync(sessionFile, "utf8"));
  validateSessionRecord(record, root);

  const ports = JSON.parse(readFileSync(join(root, ".dev", "ports.json"), "utf8"));
  validatePortsRecord(ports, root);
  const endpoint = `http://127.0.0.1:${record.debugPort}`;
  const browser = await playwright.chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close();
    throw new Error("Electron did not expose a Playwright browser context");
  }

  await context.addCookies([
    {
      name: ports.seedLogin.cookieName,
      value: ports.seedLogin.token,
      url: ports.appUrl,
    },
  ]);

  const page = await waitForAppPage(context, ports.appUrl);
  await page.reload({ waitUntil: "domcontentloaded" });
  return {
    appUrl: ports.appUrl,
    browser,
    context,
    endpoint,
    page,
    pid: record.pid,
    repoRoot: root,
    sessionFile,
  };
}

/** Disconnects Playwright from the Electron CDP session. */
export async function disconnectElectronSession(session) {
  if (!session?.browser) {
    throw new Error("Pass the session returned by connectElectronSession");
  }
  await session.browser.close();
}

async function waitForAppPage(context, appUrl) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const page = context.pages().find((candidate) => candidate.url().startsWith(appUrl));
    if (page) return page;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Electron did not open the worktree app URL within 30 seconds`);
}

function validateSessionRecord(record, root) {
  if (
    !record ||
    record.status !== "running" ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    !Number.isInteger(record.debugPort) ||
    record.debugPort <= 0 ||
    record.debugPort > 65_535 ||
    typeof record.repoRoot !== "string" ||
    resolve(record.repoRoot).toLowerCase() !== root.toLowerCase()
  ) {
    throw new Error("Electron session record is invalid or not ready");
  }
}

function validatePortsRecord(ports, root) {
  if (
    !ports ||
    typeof ports.appUrl !== "string" ||
    !ports.appUrl.startsWith("http://127.0.0.1:") ||
    typeof ports.worktreeIdentity !== "string" ||
    resolve(ports.worktreeIdentity).toLowerCase() !== root.toLowerCase() ||
    !ports.seedLogin ||
    ports.seedLogin.cookieName !== "mcode-auth" ||
    typeof ports.seedLogin.token !== "string" ||
    ports.seedLogin.token.length === 0
  ) {
    throw new Error("Worktree runtime ports record is invalid");
  }
}
