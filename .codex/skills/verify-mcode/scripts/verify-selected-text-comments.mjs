#!/usr/bin/env bun
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";

const ROOT = NodePath.resolve(import.meta.dirname, "../../../../");
const PLAYWRIGHT_PATH = NodePath.join(ROOT, ".dev/playwright-scratch/node_modules/playwright/index.js");
const FIXTURE_STATE = NodePath.join(ROOT, ".dev/verification", "selected-text-comments-fixture.json");
const PHRASE = "verification phrase";
const MESSAGE_TEXT = "Select this verification phrase";
const FIXTURE_SKILL_NAME = "verification-comment";
const COMMENT_TEXT = "Review the selected phrase.";
const EVIDENCE_DIR = NodePath.join(ROOT, ".dev/verification");
const ACTION_SCREENSHOT = NodePath.join(EVIDENCE_DIR, "selected-text-comments-action.png");
const EDITOR_SCREENSHOT = NodePath.join(EVIDENCE_DIR, "selected-text-comments-editor.png");
const RESULT_SCREENSHOT = NodePath.join(EVIDENCE_DIR, "selected-text-comments-result.png");
const RESULTS = NodePath.join(EVIDENCE_DIR, "selected-text-comments.json");

if (process.argv.includes("--help")) {
  console.log("Usage: bun verify-selected-text-comments.mjs");
  process.exit(0);
}

const assertions = {};
const diagnostics = {
  consoleErrors: [],
  failedRequests: [],
  pageErrors: [],
};
const anchorGeometry = {};
let session;
let page;

function hasValidWorkspaceId(state) {
  return typeof state.workspaceId === "string"
    && state.workspaceId.length > 0
    && /^[A-Za-z0-9_-]+$/.test(state.workspaceId);
}

function isFixtureState(state) {
  return Boolean(state)
    && typeof state === "object"
    && !Array.isArray(state)
    && Object.keys(state).sort().join(",") === "messageId,threadId,workspaceId"
    && hasValidWorkspaceId(state)
    && state.threadId === "mcode-verification-selected-text-thread"
    && state.messageId === "mcode-verification-selected-text-message";
}

async function readFixtureState() {
  const state = JSON.parse(await NodeFSPromises.readFile(FIXTURE_STATE, "utf8"));
  if (!isFixtureState(state)) {
    throw new Error("Selected text comments fixture state is invalid");
  }
  return state;
}

function mark(name, passed, details = undefined) {
  assertions[name] = details === undefined ? passed : { passed, details };
  if (!passed) throw new Error(`Assertion failed: ${name}`);
}

async function phrasePointerCoordinates(content) {
  await content.scrollIntoViewIfNeeded();
  return content.evaluate((element, phrase) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) textNodes.push(node);
    const textNode = textNodes.find((node) => node.textContent.includes(phrase));
    if (!textNode) throw new Error("Verification phrase text node not found");
    const start = textNode.textContent.indexOf(phrase);
    const startCharacter = document.createRange();
    startCharacter.setStart(textNode, start);
    startCharacter.setEnd(textNode, start + 1);
    const endCharacter = document.createRange();
    endCharacter.setStart(textNode, start + phrase.length - 1);
    endCharacter.setEnd(textNode, start + phrase.length);
    const startRect = startCharacter.getBoundingClientRect();
    const endRect = endCharacter.getBoundingClientRect();
    const contentRect = element.getBoundingClientRect();
    if (!startRect.width || !endRect.width) throw new Error("Verification phrase has no pointer target");
    const releaseX = Math.min(contentRect.right - 4, endRect.right + 48);
    if (releaseX <= endRect.right + 4) throw new Error("Verification phrase has no whitespace release target");
    return {
      start: { x: startRect.left + 1, y: startRect.top + startRect.height / 2 },
      end: { x: endRect.right - 1, y: endRect.top + endRect.height / 2 },
      release: { x: releaseX, y: endRect.top + endRect.height / 2 },
    };
  }, PHRASE);
}

async function dragSelectPhrase(content) {
  const coordinates = await phrasePointerCoordinates(content);
  await page.mouse.move(coordinates.start.x, coordinates.start.y);
  await page.mouse.down();
  await page.mouse.move(coordinates.end.x, coordinates.end.y, { steps: 8 });
  await page.mouse.move(coordinates.release.x, coordinates.release.y, { steps: 4 });
  await page.mouse.up();
  const selection = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  mark("pointer_drag_selects_phrase", selection === PHRASE, selection);
  return coordinates;
}

async function selectedRangeGeometry(content) {
  return content.evaluate((element, phrase) => {
    const selection = window.getSelection();
    const viewport = element.closest(".overflow-y-auto");
    if (!selection?.rangeCount || !viewport) throw new Error("Selected range geometry is unavailable");
    const viewportRect = viewport.getBoundingClientRect();
    const rect = [...selection.getRangeAt(0).getClientRects()].reverse().find((candidate) => (
      candidate.right > viewportRect.left
      && candidate.left < viewportRect.right
      && candidate.bottom > viewportRect.top
      && candidate.top < viewportRect.bottom
    ));
    if (!rect || selection.toString() !== phrase) throw new Error("Selected range geometry does not match the verification phrase");
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  }, PHRASE);
}

async function assertPopupAnchor(name, target, source) {
  const popup = target.locator("xpath=ancestor::*[@data-slot='popover-content']");
  const box = await popup.boundingBox();
  const details = {
    source,
    popup: box,
    horizontalOffset: box ? box.x - source.left : null,
    verticalGap: box ? box.y - source.bottom : null,
  };
  anchorGeometry[name] = details;
  mark(
    `${name}_range_anchor_proximity`,
    box !== null
      && Math.abs(details.horizontalOffset) <= 3
      && Math.abs((details.verticalGap ?? 0) - 8) <= 3,
    details,
  );
  if (name === "action") {
    mark("action_popup_width", box !== null && Math.abs(box.width - 160) <= 1, box?.width);
  }
}

async function rightClickSelectedPhrase(content) {
  const coordinates = await phrasePointerCoordinates(content);
  await content.evaluate((element) => {
    element.dataset.verificationContextMenu = "pending";
    document.addEventListener("contextmenu", (event) => {
      if (!element.contains(event.target)) return;
      element.dataset.verificationContextMenu = String(event.defaultPrevented);
    }, { once: true });
  });
  await page.mouse.click(coordinates.end.x, coordinates.end.y, { button: "right" });
  const prevented = await content.getAttribute("data-verification-context-menu");
  await page.keyboard.press("Escape");
  const selection = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  return { prevented, selection };
}

function captureDiagnostics() {
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => diagnostics.pageErrors.push(String(error)));
  page.on("requestfailed", (request) => diagnostics.failedRequests.push({
    error: request.failure()?.errorText ?? "unknown",
    url: request.url(),
  }));
}

async function waitForStatus(text) {
  const status = page.getByRole("status").filter({ hasText: text });
  await status.waitFor({ state: "visible" });
  mark(`announcement_${text.replace(/[^a-z0-9]+/gi, "_").replace(/_+$/, "").toLowerCase()}`, true);
}

async function openEditorFromSelection() {
  const addComment = page.getByRole("button", { name: "Add comment", exact: true });
  await addComment.waitFor({ state: "visible" });
  await addComment.click();
  const nativeSelection = await page.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    return window.getSelection()?.toString() ?? "";
  });
  mark("native_selection_cleared_before_editor", nativeSelection === "", nativeSelection);
  const dialog = page.getByRole("dialog", { name: "Comment on selected text", exact: true });
  await dialog.waitFor({ state: "visible" });
  return dialog;
}

async function openEditor(content) {
  await dragSelectPhrase(content);
  return openEditorFromSelection();
}

async function editorTextBox(dialog) {
  const editor = dialog.getByRole("textbox", { name: "Comment note", exact: true });
  await editor.waitFor({ state: "visible" });
  return editor;
}

async function assertEditorShell(dialog, source) {
  const editor = await editorTextBox(dialog);
  mark("comment_editor_visible", true);
  await assertPopupAnchor("editor", dialog, source);
  mark("comment_editor_focuses_note", await editor.evaluate((element) => document.activeElement === element));
  mark("selected_quote_absent", await dialog.locator("blockquote").count() === 0);
  mark("prototype_note_placeholder", await editor.getAttribute("aria-placeholder") === "Write a note");
  const editorBox = await dialog.boundingBox();
  const viewportWidth = await page.evaluate(() => window.innerWidth);
  mark(
    "prototype_editor_width",
    editorBox !== null && Math.abs(editorBox.width - Math.min(328, viewportWidth - 16)) <= 1,
    editorBox?.width,
  );
  mark("empty_comment_has_no_save_action", await dialog.getByRole("button", { name: "Add comment", exact: true }).count() === 0);
  const focusOrder = await dialog.locator('[contenteditable="true"], button').evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? ""));
  mark("new_comment_control_order", JSON.stringify(focusOrder) === JSON.stringify(["Comment note", "Close comment editor"]), focusOrder);
  const restrictedControls = await dialog.locator('input[type="file"], select, [role="combobox"]').count()
    + await dialog.getByRole("button", { name: /attach|model|provider/i }).count();
  mark("editor_has_no_attachment_model_or_provider_control", restrictedControls === 0, restrictedControls);
  return editor;
}

async function clickOutsideDialog() {
  const dialog = page.getByRole("dialog", { name: "Comment on selected text", exact: true });
  const box = await dialog.boundingBox();
  if (!box) throw new Error("Comment editor has no bounding box");
  const x = box.x > 8 ? 4 : Math.ceil(box.x + box.width + 4);
  await page.mouse.click(x, 4);
}

async function assertDirtyDismissal(content) {
  let dialog = await openEditor(content);
  let editor = await editorTextBox(dialog);
  await editor.pressSequentially("Close button draft");
  const close = dialog.getByRole("button", { name: "Close comment editor", exact: true });
  await close.click();
  await waitForStatus("Repeat this action to discard this comment.");
  mark("first_dirty_close_keeps_editor_open", await dialog.isVisible());
  await close.click();
  await dialog.waitFor({ state: "hidden" });
  mark("second_dirty_close_discards_editor", true);

  dialog = await openEditor(content);
  editor = await editorTextBox(dialog);
  await editor.pressSequentially("Outside draft");
  await clickOutsideDialog();
  await waitForStatus("Repeat this action to discard this comment.");
  mark("first_dirty_outside_click_keeps_editor_open", await dialog.isVisible());
  await clickOutsideDialog();
  await dialog.waitFor({ state: "hidden" });
  mark("second_dirty_outside_click_discards_editor", true);

  dialog = await openEditor(content);
  editor = await editorTextBox(dialog);
  await editor.pressSequentially("First escape draft");
  await page.keyboard.press("Escape");
  await waitForStatus("Press Escape again to discard this comment.");
  await editor.pressSequentially(" updated");
  await page.keyboard.press("Escape");
  await waitForStatus("Press Escape again to discard this comment.");
  mark("editing_resets_escape_warning", await dialog.isVisible());
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  mark("second_dirty_escape_discards_editor", true);
}

async function run() {
  const fixture = await readFixtureState();
  const playwright = await import(PLAYWRIGHT_PATH);
  const helper = await import("../../electorn-live-testing/scripts/electron-session.mjs");
  session = await helper.connectElectronSession({ playwright, repoRoot: ROOT });
  page = session.page;
  captureDiagnostics();

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
  await dragSelectPhrase(content);
  const sourceGeometry = await selectedRangeGeometry(content);
  const addComment = page.getByRole("button", { name: "Add comment", exact: true });
  await addComment.waitFor({ state: "visible" });
  mark("add_comment_visible", true);
  await assertPopupAnchor("action", addComment, sourceGeometry);
  const visibleCopyCount = await page.getByRole("button", { name: "Copy", exact: true }).evaluateAll((buttons) => buttons.filter((button) => {
    const style = getComputedStyle(button);
    return style.visibility !== "hidden" && style.display !== "none" && button.getBoundingClientRect().width > 0;
  }).length);
  mark("copy_button_absent", visibleCopyCount === 0, visibleCopyCount);
  await NodeFSPromises.mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: ACTION_SCREENSHOT, fullPage: true });
  let dialog = await openEditorFromSelection();
  const editor = await assertEditorShell(dialog, sourceGeometry);
  await editor.pressSequentially(`/${FIXTURE_SKILL_NAME}`);
  const slashSkill = page.getByRole("option", { name: new RegExp(FIXTURE_SKILL_NAME, "i") });
  await slashSkill.waitFor({ state: "visible" });
  await slashSkill.click();
  const skillChip = editor.locator('[data-entity-token="skill"]', { hasText: FIXTURE_SKILL_NAME });
  await skillChip.waitFor({ state: "visible" });
  mark("selected_skill_chip_visible", true);
  await editor.pressSequentially("@README");
  const readme = page.getByRole("option", { name: "README.md", exact: true });
  await readme.waitFor({ state: "visible" });
  await readme.click();
  const fileChip = editor.locator('[data-entity-token="file"]', { hasText: "README.md" });
  await fileChip.waitFor({ state: "visible" });
  mark("selected_file_chip_visible", true);
  await editor.press("Enter");
  await editor.pressSequentially(COMMENT_TEXT);
  const editorText = await editor.innerText();
  mark("comment_note_is_multiline", editorText.includes(`\n${COMMENT_TEXT}`), editorText);
  await page.screenshot({ path: EDITOR_SCREENSHOT, fullPage: true });
  await editor.press("Control+Enter");
  await dialog.waitFor({ state: "hidden" });
  await waitForStatus("Comment 1 added.");
  const commentAttachment = page.getByTestId("selected-text-comment-attachment");
  await commentAttachment.waitFor({ state: "visible" });
  const details = commentAttachment.getByRole("button", { name: "1 comment. Details available.", exact: true });
  mark("saved_comment_attachment_visible", true);
  mark("saved_comment_attachment_label", await details.isVisible());
  await page.screenshot({ path: RESULT_SCREENSHOT, fullPage: true });

  dialog = await openEditor(content);
  await dialog.getByRole("button", { name: "Close comment editor", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  mark("clean_close_discards_editor", true);
  await assertDirtyDismissal(content);

  await dragSelectPhrase(content);
  const contextMenu = await rightClickSelectedPhrase(content);
  mark("pointer_right_click_context_menu_not_prevented", contextMenu.prevented === "false", contextMenu.prevented);
  mark("selection_preserved", contextMenu.selection === PHRASE, contextMenu.selection);
  await commentAttachment.getByRole("button", { name: "Remove 1 comment", exact: true }).click();
  await commentAttachment.waitFor({ state: "hidden" });
  mark("aggregate_remove_clears_comment_attachment", true);

  await NodeFSPromises.writeFile(RESULTS, JSON.stringify({
    passed: true,
    assertions,
    contextMenu,
    diagnostics,
    anchorGeometry,
    evidence: {
      actionScreenshot: NodePath.basename(ACTION_SCREENSHOT),
      editorScreenshot: NodePath.basename(EDITOR_SCREENSHOT),
      resultScreenshot: NodePath.basename(RESULT_SCREENSHOT),
    },
  }, null, 2));
}

try {
  await run();
} catch (error) {
  await NodeFSPromises.mkdir(EVIDENCE_DIR, { recursive: true });
  if (page) await page.screenshot({ path: EDITOR_SCREENSHOT, fullPage: true }).catch(() => {});
  await NodeFSPromises.writeFile(RESULTS, JSON.stringify({ passed: false, assertions, diagnostics, error: String(error?.stack ?? error) }, null, 2));
  throw error;
} finally {
  if (session) {
    const helper = await import("../../electorn-live-testing/scripts/electron-session.mjs");
    await helper.disconnectElectronSession(session);
  }
}
