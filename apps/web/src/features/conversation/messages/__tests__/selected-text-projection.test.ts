import { describe, expect, it, vi } from "vitest";
import { MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS } from "@mcode/contracts";
import {
  createSelectedTextCommentSource,
  createCanonicalMessageTextProjection,
  findSelectedTextCommentContent,
  lastVisibleRangeRect,
  reconstructCanonicalMessageRange,
} from "../selected-text-projection";

function renderMessageContent(): HTMLElement {
  const content = document.createElement("div");
  content.innerHTML = [
    "<p>Alpha <code>β</code></p>",
    "<pre>  code\nline</pre>",
    "<p>Final<br>line</p>",
    '<button data-selected-text-exclude>Copy</button>',
  ].join("");
  return content;
}

describe("selected-text message projection", () => {
  it("uses visible prose and code in DOM order with block and line-break boundaries", () => {
    const projection = createCanonicalMessageTextProjection(renderMessageContent());

    expect(projection.text).toBe("Alpha β\n  code\nline\nFinal\nline\n");
  });

  it("reconstructs only the exact UTF-16 range and rejects a changed quote", () => {
    const content = renderMessageContent();
    const exact = reconstructCanonicalMessageRange(content, 6, 7, "β");
    const changed = reconstructCanonicalMessageRange(content, 6, 7, "b");

    expect(exact?.toString()).toBe("β");
    expect(changed).toBeNull();
  });

  it("finds an exact source and uses the last range rect visible in the message viewport", () => {
    const host = document.createElement("div");
    host.innerHTML = [
      '<div data-testid="message-viewport">',
      '<article data-message-id="message-1" data-message-role="assistant" data-thread-id="thread-1">',
      '<div data-selected-text-content data-selected-text-eligible="true">Alpha beta</div>',
      "</article>",
      '<article data-message-id="message-1" data-message-role="assistant" data-thread-id="thread-2">',
      '<div data-selected-text-content data-selected-text-eligible="true">Other thread</div>',
      "</article>",
      '<article data-message-id="message-2" data-message-role="assistant" data-thread-id="thread-1">',
      '<div data-selected-text-content data-selected-text-eligible="false">Ineligible</div>',
      "</article>",
      "</div>",
      '<article data-message-id="message-1" data-message-role="assistant" data-thread-id="thread-1">',
      '<div data-selected-text-content data-selected-text-eligible="true">Duplicate surface</div>',
      "</article>",
    ].join("");
    document.body.append(host);
    const viewport = host.querySelector<HTMLElement>('[data-testid="message-viewport"]')!;
    const source = {
      threadId: "thread-1",
      messageId: "message-1",
      sourceRole: "assistant" as const,
      start: 0,
      end: 5,
      quote: "Alpha",
    };
    const first = new DOMRect(40, 80, 60, 20);
    const second = new DOMRect(40, 140, 60, 20);
    const third = new DOMRect(40, 220, 60, 20);
    const range = { getClientRects: () => [first, second, third] } as unknown as Range;
    let viewportRect = new DOMRect(0, 100, 400, 100);
    vi.spyOn(viewport, "getBoundingClientRect").mockImplementation(() => viewportRect);

    expect(findSelectedTextCommentContent(source, viewport, "thread-1")?.textContent).toBe("Alpha beta");
    expect(findSelectedTextCommentContent(source, viewport, "thread-2")).toBeNull();
    expect(findSelectedTextCommentContent({ ...source, messageId: "message-2", quote: "Ineligible" }, viewport, "thread-1")).toBeNull();
    expect(lastVisibleRangeRect(range, viewport)).toBe(second);

    viewportRect = new DOMRect(0, 200, 400, 100);
    expect(lastVisibleRangeRect(range, viewport)).toBe(third);
    host.remove();
  });

  it("accepts a pointer-selected UTF-16 range from one completed eligible message only", () => {
    const host = document.createElement("div");
    host.innerHTML = [
      '<article data-message-id="message-1" data-message-role="assistant" data-thread-id="thread-1">',
      '<div data-selected-text-content data-selected-text-eligible="true">Hi 🙂 there</div>',
      "</article>",
      '<article data-message-id="message-2" data-message-role="assistant" data-thread-id="thread-1">',
      '<div data-selected-text-content data-selected-text-eligible="true">Other</div>',
      "</article>",
    ].join("");
    document.body.append(host);
    const content = host.querySelector<HTMLElement>("[data-selected-text-content]")!;
    const text = content.firstChild!;
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(text, 3);
    range.setEnd(text, 5);
    selection.removeAllRanges();
    selection.addRange(range);

    const selected = createSelectedTextCommentSource(selection, content);

    expect(selected).toEqual({
      threadId: "thread-1",
      messageId: "message-1",
      sourceRole: "assistant",
      start: 3,
      end: 5,
      quote: "🙂",
    });

    const otherText = host.querySelectorAll<HTMLElement>("[data-selected-text-content]")[1]
      .firstChild!;
    range.setStart(text, 0);
    range.setEnd(otherText, 5);
    selection.removeAllRanges();
    selection.addRange(range);

    expect(createSelectedTextCommentSource(selection, content)).toBeNull();
    selection.removeAllRanges();
    host.remove();
  });

  it("reconstructs a selection across assistant list items from its canonical line breaks", () => {
    const host = document.createElement("div");
    host.innerHTML = [
      '<article data-message-id="message-1" data-message-role="assistant" data-thread-id="thread-1">',
      '<div data-selected-text-content data-selected-text-eligible="true"><ul><li>First</li><li>Second</li><li>Third</li></ul></div>',
      "</article>",
    ].join("");
    document.body.append(host);
    const content = host.querySelector<HTMLElement>("[data-selected-text-content]")!;
    const listItems = content.querySelectorAll("li");
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(listItems[0].firstChild!, 0);
    range.setEnd(listItems[2].firstChild!, listItems[2].textContent!.length);
    selection.removeAllRanges();
    selection.addRange(range);

    const source = createSelectedTextCommentSource(selection, listItems[2]);

    expect(source).toMatchObject({
      start: 0,
      end: 18,
      quote: "First\nSecond\nThird",
    });
    expect(reconstructCanonicalMessageRange(content, source!.start, source!.end, source!.quote)?.toString()).toBe("FirstSecondThird");

    selection.removeAllRanges();
    host.remove();
  });

  it("rejects selections that cross excluded content but accepts text beside it", () => {
    const host = document.createElement("div");
    host.innerHTML = [
      '<article data-message-id="message-1" data-message-role="assistant" data-thread-id="thread-1">',
      '<div data-selected-text-content data-selected-text-eligible="true"><span>Before</span><button data-selected-text-exclude>Copy</button><span>After</span></div>',
      "</article>",
    ].join("");
    document.body.append(host);
    const content = host.querySelector<HTMLElement>("[data-selected-text-content]")!;
    const before = content.children[0].firstChild!;
    const after = content.children[2].firstChild!;
    const selection = document.getSelection()!;
    const range = document.createRange();

    range.setStart(before, 0);
    range.setEnd(after, after.textContent!.length);
    selection.removeAllRanges();
    selection.addRange(range);

    expect(createSelectedTextCommentSource(selection, content)).toBeNull();

    range.setStart(before, 0);
    range.setEnd(content, 1);
    selection.removeAllRanges();
    selection.addRange(range);

    expect(createSelectedTextCommentSource(selection, content)?.quote).toBe("Before");

    range.setStart(content, 2);
    range.setEnd(after, after.textContent!.length);
    selection.removeAllRanges();
    selection.addRange(range);

    expect(createSelectedTextCommentSource(selection, content)?.quote).toBe("After");
    selection.removeAllRanges();
    host.remove();
  });

  it("accepts source selections through the thread-message payload limit", () => {
    const host = document.createElement("div");
    const quote = "x".repeat(MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS);
    host.innerHTML = [
      '<article data-message-id="message-1" data-message-role="assistant" data-thread-id="thread-1">',
      '<div data-selected-text-content data-selected-text-eligible="true"></div>',
      "</article>",
    ].join("");
    document.body.append(host);
    const content = host.querySelector<HTMLElement>("[data-selected-text-content]")!;
    content.textContent = quote;
    const text = content.firstChild!;
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, quote.length);
    selection.removeAllRanges();
    selection.addRange(range);

    expect(createSelectedTextCommentSource(selection, content)?.quote).toHaveLength(quote.length);

    content.textContent = `${quote}x`;
    const longerText = content.firstChild!;
    range.setStart(longerText, 0);
    range.setEnd(longerText, quote.length + 1);
    selection.removeAllRanges();
    selection.addRange(range);

    expect(createSelectedTextCommentSource(selection, content)).toBeNull();
    selection.removeAllRanges();
    host.remove();
  });
});
