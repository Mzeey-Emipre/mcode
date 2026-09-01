#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../../../");
const PLAYWRIGHT_PATH = path.join(ROOT, ".dev/playwright-scratch/node_modules/playwright/index.js");
const FIXTURE_STATE = path.join(ROOT, ".dev/verification", "selected-text-comments-fixture.json");
const PHRASE = "verification phrase";
const MESSAGE_TEXT = "Select this verification phrase";
const EVIDENCE_DIR = path.join(ROOT, ".dev/verification");
const SCREENSHOT = path.join(EVIDENCE_DIR, "selected-text-comments.png");
const RESULTS = path.join(EVIDENCE_DIR, "selected-text-comments.json");

if (process.argv.includes("--help")) {
  console.log("Usage: bun verify-selected-text-comments.mjs");
  process.exit(0);
}

const assertions = {};
let session;
let page;
let screenshotCaptured = false;

async function readFixtureState() {
  const state = JSON.parse(await fs.readFile(FIXTURE_STATE, "utf8"));
  if (
    !state
    || typeof state !== "object"
    || Array.isArray(state)
    || Object.keys(state).sort().join(",") !== "messageId,threadId,workspaceId"
    || typeof state.workspaceId !== "string"
    || state.workspaceId.length === 0
    || !/^[A-Za-z0-9_-]+$/.test(state.workspaceId)
    || typeof state.threadId !== "string"
    || state.threadId !== "mcode-verification-selected-text-thread"
    || state.messageId !== "mcode-verification-selected-text-message"
  ) {
    throw new Error("Selected text comments fixture state is invalid");
  }
  return state;
}

function mark(name, passed, details = undefined) {
  assertions[name] = details === undefined ? passed : { passed, details };
  if (!passed) throw new Error(`Assertion failed: ${name}`);
}

async function selectPhrase(content) {
  await content.evaluate((element, phrase) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) textNodes.push(node);
    const textNode = textNodes.find((node) => node.textContent.includes(phrase));
    if (!textNode) throw new Error("Verification phrase text node not found");
    const start = textNode.textContent.indexOf(phrase);
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + phrase.length);
    const rect = range.getBoundingClientRect();
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    const clientX = Math.min(Math.max(rect.right, 0), Math.max(window.innerWidth - 1, 0));
    const clientY = Math.min(Math.max(rect.bottom, 0), Math.max(window.innerHeight - 1, 0));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX, clientY }));
  }, PHRASE);
}

async function run() {
  const fixture = await readFixtureState();
  const playwright = await import(PLAYWRIGHT_PATH);
  const helper = await import("./electron-session.mjs");
  session = await helper.connectElectronSession({ playwright, repoRoot: ROOT });
  page = session.page;

  const project = page.locator(`[data-testid="project-row-${fixture.workspaceId}"]`);
  const thread = page.locator(`[data-testid="thread-item"][data-thread-id="${fixture.threadId}"]`);
  await project.waitFor({ state: "visible" });
  if (!(await thread.isVisible().catch(() => false))) {
    const toggle = project.locator('button[aria-label^="Toggle threads for "]');
    const expanded = await toggle.getAttribute("aria-expanded");
    if (expanded === "true") {
      await project.click();
      await project.click();
    } else if (expanded === "false") {
      await project.click();
    } else {
      throw new Error("Project thread toggle has an invalid expansion state");
    }
    await thread.waitFor({ state: "visible" });
  }
  await thread.click();
  const content = page.locator("[data-selected-text-content][data-selected-text-eligible=\"true\"]").filter({ hasText: MESSAGE_TEXT });
  await content.waitFor({ state: "visible" });
  mark("eligible_content_visible", true);
  await selectPhrase(content);
  const addComment = page.getByRole("button", { name: "Add comment", exact: true });
  await addComment.waitFor({ state: "visible" });
  mark("add_comment_visible", true);
  const visibleCopyCount = await page.getByRole("button", { name: "Copy", exact: true }).evaluateAll((buttons) => buttons.filter((button) => {
    const style = getComputedStyle(button);
    return style.visibility !== "hidden" && style.display !== "none" && button.getBoundingClientRect().width > 0;
  }).length);
  mark("copy_button_absent", visibleCopyCount === 0, visibleCopyCount);
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: SCREENSHOT, fullPage: true });
  screenshotCaptured = true;
  const contextMenu = await content.evaluate((element) => {
    let prevented;
    const listener = (event) => { prevented = event.defaultPrevented; };
    document.addEventListener("contextmenu", listener, { once: true });
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    return { prevented, selection: window.getSelection()?.toString() };
  });
  mark("context_menu_not_prevented", contextMenu.prevented === false, contextMenu.prevented);
  mark("selection_preserved", contextMenu.selection === PHRASE, contextMenu.selection);
  await fs.writeFile(RESULTS, JSON.stringify({ passed: true, assertions, contextMenu }, null, 2));
}

try {
  await run();
} catch (error) {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  if (page && !screenshotCaptured) await page.screenshot({ path: SCREENSHOT, fullPage: true }).catch(() => {});
  await fs.writeFile(RESULTS, JSON.stringify({ passed: false, assertions, error: String(error?.stack ?? error) }, null, 2));
  throw error;
} finally {
  if (session) await (await import("./electron-session.mjs")).disconnectElectronSession(session);
}
