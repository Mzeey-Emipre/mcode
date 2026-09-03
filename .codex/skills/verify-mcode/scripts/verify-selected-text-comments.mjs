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
const SECOND_COMMENT_TEXT = "Review the selected phrase again.";
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
    textNode.parentElement?.scrollIntoView({ block: "center", inline: "nearest" });
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
  const activeElement = await page.evaluate(() => {
    const element = document.activeElement;
    return {
      tagName: element?.tagName ?? null,
      role: element?.getAttribute("role") ?? null,
      ariaLabel: element?.getAttribute("aria-label") ?? null,
      id: element?.id ?? null,
    };
  });
  mark("comment_editor_focuses_note", await editor.evaluate((element) => document.activeElement === element), activeElement);
  mark("selected_quote_absent", await dialog.locator("blockquote").count() === 0);
  mark("prototype_note_placeholder", await editor.getAttribute("aria-placeholder") === "Write a note");
  const placeholderAlignment = await dialog.getByText("Write a note", { exact: true }).evaluate((placeholder, textbox) => {
    const placeholderRect = placeholder.getBoundingClientRect();
    const textboxRect = textbox.getBoundingClientRect();
    return {
      centerDelta: Math.abs(
        placeholderRect.top + placeholderRect.height / 2
        - (textboxRect.top + textboxRect.height / 2)
      ),
    };
  }, await editor.elementHandle());
  mark(
    "comment_editor_placeholder_is_vertically_centered",
    placeholderAlignment.centerDelta <= 1,
    placeholderAlignment,
  );
  const editorBox = await dialog.boundingBox();
  const viewportBounds = await page.evaluate(() => {
    const viewport = document.querySelector(".overflow-y-auto");
    const bounds = viewport?.getBoundingClientRect();
    return bounds && { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
  });
  mark(
    "prototype_editor_width",
    editorBox !== null
      && viewportBounds !== null
      && editorBox.width <= Math.min(328, viewportBounds.right - viewportBounds.left - 16) + 1
      && editorBox.x >= viewportBounds.left + 8 - 1
      && editorBox.x + editorBox.width <= viewportBounds.right - 8 + 1,
    editorBox?.width,
  );
  mark(
    "editor_height_stays_in_visible_transcript",
    editorBox !== null
      && viewportBounds !== null
      && editorBox.height <= viewportBounds.bottom - viewportBounds.top - 16 + 1,
    editorBox?.height,
  );
  mark("comment_note_scrolls_internally", await editor.evaluate((element) => getComputedStyle(element).overflowY === "auto"));
  mark("empty_comment_has_no_save_action", await dialog.getByRole("button", { name: "Add comment", exact: true }).count() === 0);
  const focusOrder = await dialog.locator('[contenteditable="true"], button').evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? ""));
  mark("new_comment_control_order", JSON.stringify(focusOrder) === JSON.stringify(["Comment note", "Close comment editor"]), focusOrder);
  const restrictedControls = await dialog.locator('input[type="file"], select, [role="combobox"]').count()
    + await dialog.getByRole("button", { name: /attach|model|provider/i }).count();
  mark("editor_has_no_attachment_model_or_provider_control", restrictedControls === 0, restrictedControls);
  return editor;
}

async function assertSourceDockAndReturn(content) {
  await content.evaluate((element, phrase) => {
    const viewport = element.closest(".overflow-y-auto");
    if (!viewport || !element.textContent?.includes(phrase)) throw new Error("Scrollable verification source is unavailable");
    viewport.scrollTop = 0;
  }, PHRASE);
  await page.waitForFunction((phrase) => {
    const content = [...document.querySelectorAll("[data-selected-text-content]")]
      .find((element) => element.textContent?.includes(phrase));
    const viewport = content?.closest(".overflow-y-auto");
    const dialog = document.querySelector('[role="dialog"][aria-label="Comment on selected text"]');
    if ([content, viewport, dialog].some((value) => !value)) return false;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    let textNode = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.includes(phrase)) {
        textNode = node;
        break;
      }
    }
    if (!textNode) return false;
    const start = textNode.textContent.indexOf(phrase);
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + phrase.length);
    const source = range.getBoundingClientRect();
    const viewportBounds = viewport.getBoundingClientRect();
    const editorBounds = dialog.getBoundingClientRect();
    return source.top >= viewportBounds.bottom
      && Math.abs(editorBounds.bottom - (viewportBounds.bottom - 8)) <= 3;
  }, PHRASE);
  mark("source_scroll_out_docks_editor_at_nearest_edge", true);

  await content.evaluate((element, phrase) => {
    const viewport = element.closest(".overflow-y-auto");
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let textNode = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.includes(phrase)) {
        textNode = node;
        break;
      }
    }
    if (!viewport || !textNode) throw new Error("Scrollable verification source is unavailable");
    const start = textNode.textContent.indexOf(phrase);
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + phrase.length);
    const source = range.getBoundingClientRect();
    const viewportBounds = viewport.getBoundingClientRect();
    viewport.scrollBy({ top: source.top - viewportBounds.top - viewportBounds.height / 2 });
  }, PHRASE);
  await page.waitForFunction((phrase) => {
    const content = [...document.querySelectorAll("[data-selected-text-content]")]
      .find((element) => element.textContent?.includes(phrase));
    const viewport = content?.closest(".overflow-y-auto");
    const dialog = document.querySelector('[role="dialog"][aria-label="Comment on selected text"]');
    if ([content, viewport, dialog].some((value) => !value)) return false;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    let textNode = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.includes(phrase)) {
        textNode = node;
        break;
      }
    }
    if (!textNode) return false;
    const start = textNode.textContent.indexOf(phrase);
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + phrase.length);
    const source = [...range.getClientRects()].reverse().find((candidate) => {
      const viewportBounds = viewport.getBoundingClientRect();
      return candidate.right > viewportBounds.left
        && candidate.left < viewportBounds.right
        && candidate.bottom > viewportBounds.top
        && candidate.top < viewportBounds.bottom;
    });
    if (!source) return false;
    const editorBounds = dialog.getBoundingClientRect();
    return [
      Math.abs(editorBounds.top - source.bottom - 8) <= 3,
      Math.abs(editorBounds.bottom - source.top + 8) <= 3,
    ].includes(true);
  }, PHRASE);
  mark("source_return_reconstructs_current_range_and_reanchors_editor", true);
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
  await dialog.waitFor({ state: "hidden" });
  mark("dirty_close_button_discards_editor_immediately", true);

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

async function assertSavedCommentMarkerAndCardLifecycle(
  content,
  commentAttachment,
  firstAnnotationPreview,
  firstMarker,
) {
  let dialog = await openEditor(content);
  const secondEditor = await editorTextBox(dialog);
  await secondEditor.pressSequentially(SECOND_COMMENT_TEXT);
  await secondEditor.press("Control+Enter");
  await dialog.waitFor({ state: "hidden" });
  await waitForStatus("Comment 2 added.");
  await firstMarker.focus();
  await page.keyboard.press("Enter");
  await dialog.waitFor({ state: "visible" });
  mark("marker_enter_opens_source_editor", true);
  const markerEditor = await editorTextBox(dialog);
  mark("marker_editor_focuses_note", await markerEditor.evaluate((element) => document.activeElement === element));
  mark(
    "saved_editor_has_one_x_close_and_accessible_delete",
    await dialog.locator("svg.lucide-x").count() === 1
      && await dialog.getByRole("button", { name: "Delete comment", exact: true }).count() === 1,
  );
  await dialog.getByRole("button", { name: "Delete comment", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await firstMarker.waitFor({ state: "visible" });
  mark(
    "marker_delete_removes_annotation_and_renumbers_survivor",
    await page.getByTestId("selected-text-comment-marker").count() === 1
      && await page.getByRole("button", { name: "Open comment 1", exact: true }).count() === 1
      && await page.getByRole("button", { name: "Open comment 2", exact: true }).count() === 0,
  );
  mark("marker_delete_returns_focus_to_survivor", await firstMarker.evaluate((element) => document.activeElement === element));

  dialog = await openEditor(content);
  const replacementEditor = await editorTextBox(dialog);
  await replacementEditor.pressSequentially(SECOND_COMMENT_TEXT);
  await replacementEditor.press("Control+Enter");
  await dialog.waitFor({ state: "hidden" });
  await waitForStatus("Comment 2 added.");
  const secondAnnotationPreview = commentAttachment.getByRole("button", { name: "2 annotations. Preview available.", exact: true });
  const secondMarker = page.getByRole("button", { name: "Open comment 2", exact: true });
  await secondMarker.waitFor({ state: "visible" });
  mark(
    "saved_comments_keep_creation_order_markers",
    JSON.stringify(await page.getByTestId("selected-text-comment-marker").evaluateAll((markers) => markers.map((marker) => marker.getAttribute("aria-label"))))
      === JSON.stringify(["Open comment 1", "Open comment 2"]),
  );
  mark(
    "dense_marker_collision_keeps_both_focusable_markers",
    await firstMarker.isVisible() && await secondMarker.isVisible(),
  );
  await secondMarker.focus();
  await page.keyboard.press("Space");
  await dialog.waitFor({ state: "visible" });
  mark("marker_space_opens_source_editor", true);
  await dialog.getByRole("button", { name: "Close comment editor", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await secondAnnotationPreview.hover();
  const firstPreviewItem = page.getByTestId("selected-text-comment-preview-item-1");
  const secondPreviewItem = page.getByTestId("selected-text-comment-preview-item-2");
  await secondPreviewItem.waitFor({ state: "visible" });
  mark("second_annotation_preview_visible_on_hover", true);
  mark("multi_annotation_preview_actions_hidden_at_rest", await page.getByRole("button", { name: /^Delete comment [12]$/ }).count() === 0);
  await firstPreviewItem.hover();
  mark(
    "multi_annotation_preview_reveals_relevant_item_actions",
    await page.getByRole("button", { name: "Edit comment 1", exact: true }).count() === 0
      && await page.getByRole("button", { name: "Delete comment 1", exact: true }).count() === 1
      && await page.getByRole("button", { name: "Delete comment 2", exact: true }).count() === 0,
  );
  await page.getByRole("button", { name: "Open source for comment 1", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Comment on selected text", exact: true });
  mark("source_card_navigation_does_not_open_editor", await dialog.count() === 0);
  await secondPreviewItem.hover();
  await page.getByRole("button", { name: "Delete comment 2", exact: true }).click();
  await page.getByTestId("selected-text-comment-preview-item-2").waitFor({ state: "hidden" });
  mark("direct_card_delete_removes_annotation", await page.getByTestId("selected-text-comment-preview-item-1").isVisible());
  mark(
    "direct_card_delete_renumbers_marker_accessible_name",
    await page.getByRole("button", { name: "Open comment 1", exact: true }).count() === 1
      && await page.getByRole("button", { name: "Open comment 2", exact: true }).count() === 0,
  );
  await firstMarker.focus();
  await page.keyboard.press("Enter");
  await dialog.waitFor({ state: "visible" });
  const savedEditor = await editorTextBox(dialog);
  await savedEditor.pressSequentially(" updated");
  await dialog.getByRole("button", { name: "Save comment", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  mark("marker_saved_edit_returns_focus_to_marker", await firstMarker.evaluate((element) => document.activeElement === element));
  await firstAnnotationPreview.hover();
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
  await assertSourceDockAndReturn(content);
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
  mark("saved_comment_attachment_visible", true);
  const commentAttachmentChip = commentAttachment.getByTestId("selected-text-comment-chip");
  const commentAttachmentChipBox = await commentAttachmentChip.boundingBox();
  mark("saved_comment_attachment_is_compact", commentAttachmentChipBox !== null && Math.abs(commentAttachmentChipBox.height - 32) <= 1, commentAttachmentChipBox?.height);
  const firstAnnotationPreview = commentAttachment.getByRole("button", { name: "1 annotation. Preview available.", exact: true });
  const firstMarker = page.getByRole("button", { name: "Open comment 1", exact: true });
  await firstMarker.waitFor({ state: "visible" });
  mark(
    "saved_comment_has_one_source_highlight_and_marker",
    await page.getByTestId("selected-text-comment-highlight").count() === 1
      && await page.getByTestId("selected-text-comment-marker").count() === 1,
  );
  await firstMarker.hover();
  mark(
    "marker_hover_strengthens_linked_highlight",
    await page.getByTestId("selected-text-comment-highlight").locator("> div").evaluate((highlight) => highlight.classList.contains("bg-primary/30")),
  );
  const commentPreview = page.getByTestId("selected-text-comment-preview");
  mark("annotation_preview_hidden_at_rest", await commentPreview.count() === 0);
  await firstAnnotationPreview.hover();
  await commentPreview.waitFor({ state: "visible" });
  mark("annotation_preview_opens_on_hover", true);
  const previewStacking = await page.evaluate(async () => {
    const preview = document.querySelector("[data-testid='selected-text-comment-preview']");
    const highlight = document.querySelector("[data-testid='selected-text-comment-highlight'] > div");
    if (!(preview instanceof HTMLElement) || !(highlight instanceof HTMLElement)) {
      return { exercised: false, previewOwnsOverlap: false };
    }
    const viewport = highlight.closest("[data-testid='message-list']")?.querySelector(".overflow-y-auto");
    if (!(viewport instanceof HTMLElement)) return { exercised: false, previewOwnsOverlap: false };
    const previewRect = preview.getBoundingClientRect();
    const highlightRect = highlight.getBoundingClientRect();
    const originalScrollTop = viewport.scrollTop;
    viewport.scrollTop += highlightRect.top + highlightRect.height / 2
      - (previewRect.top + previewRect.height / 2);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const movedPreviewRect = preview.getBoundingClientRect();
    const movedHighlightRect = highlight.getBoundingClientRect();
    const left = Math.max(movedPreviewRect.left, movedHighlightRect.left);
    const right = Math.min(movedPreviewRect.right, movedHighlightRect.right);
    const top = Math.max(movedPreviewRect.top, movedHighlightRect.top);
    const bottom = Math.min(movedPreviewRect.bottom, movedHighlightRect.bottom);
    const exercised = right > left && bottom > top;
    const topElement = exercised ? document.elementFromPoint((left + right) / 2, (top + bottom) / 2) : null;
    viewport.scrollTop = originalScrollTop;
    return { exercised, previewOwnsOverlap: topElement !== null && preview.contains(topElement) };
  });
  mark(
    "annotation_preview_paints_above_source_highlight",
    previewStacking.exercised && previewStacking.previewOwnsOverlap,
    previewStacking,
  );
  mark("annotation_preview_selected_text_label", await commentPreview.getByText("1. Selected text:", { exact: true }).isVisible());
  mark("annotation_preview_user_comment_label", await commentPreview.getByText("User comment:", { exact: true }).isVisible());
  mark("single_annotation_preview_omits_item_delete", await page.getByRole("button", { name: "Delete comment 1", exact: true }).count() === 0);
  await page.mouse.move(0, 0);
  await commentPreview.waitFor({ state: "hidden" });
  await firstAnnotationPreview.focus();
  await commentPreview.waitFor({ state: "visible" });
  mark("annotation_preview_opens_on_keyboard_focus", true);

  await assertSavedCommentMarkerAndCardLifecycle(
    content,
    commentAttachment,
    firstAnnotationPreview,
    firstMarker,
  );
  await firstAnnotationPreview.focus();
  await page.waitForFunction(() => {
    const annotationCount = document.querySelector('button[aria-label="1 annotation. Preview available."]');
    const preview = document.querySelector("[data-testid='selected-text-comment-preview']");
    if (!annotationCount || !preview || document.activeElement !== annotationCount || !annotationCount.matches(":hover")) return false;
    return [...preview.querySelectorAll("[data-testid^='selected-text-comment-preview-item-']")].every((item) => {
      const actionGroup = item.querySelector("div.absolute.top-2.right-0");
      if (!actionGroup) return true;
      const styles = getComputedStyle(actionGroup);
      return styles.display === "none" || styles.visibility === "hidden" || styles.opacity === "0";
    });
  });
  const restingActionChrome = await commentPreview.locator("[data-testid^='selected-text-comment-preview-item-']").evaluateAll((items) => (
    items.map((item) => {
      const actionGroup = item.querySelector("div.absolute.top-2.right-0");
      if (!actionGroup) return { rendered: false };
      const styles = getComputedStyle(actionGroup);
      return {
        rendered: true,
        display: styles.display,
        visibility: styles.visibility,
        opacity: styles.opacity,
      };
    })
  ));
  mark(
    "result_preview_item_action_chrome_hidden_at_rest",
    restingActionChrome.every((action) => !action.rendered
      || action.display === "none"
      || action.visibility === "hidden"
      || action.opacity === "0"),
    restingActionChrome,
  );
  await page.screenshot({ path: RESULT_SCREENSHOT, fullPage: true });

  dialog = await openEditor(content);
  await dialog.getByRole("button", { name: "Close comment editor", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  mark("clean_close_discards_editor", true);
  const returnedAction = page.getByRole("button", { name: "Add comment", exact: true });
  await returnedAction.waitFor({ state: "visible" });
  mark("clean_close_returns_focus_to_add_comment", await returnedAction.evaluate((element) => document.activeElement === element));
  await assertDirtyDismissal(content);

  await dragSelectPhrase(content);
  const contextMenu = await rightClickSelectedPhrase(content);
  mark("pointer_right_click_context_menu_not_prevented", contextMenu.prevented === "false", contextMenu.prevented);
  mark("selection_preserved", contextMenu.selection === PHRASE, contextMenu.selection);
  await firstMarker.focus();
  await page.keyboard.press("Enter");
  await dialog.waitFor({ state: "visible" });
  await dialog.getByRole("button", { name: "Delete comment", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await commentAttachment.waitFor({ state: "hidden" });
  const composer = page.getByRole("textbox", { name: "Message Mcode", exact: true });
  mark("final_marker_delete_returns_focus_to_composer", await composer.evaluate((element) => document.activeElement === element));

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
