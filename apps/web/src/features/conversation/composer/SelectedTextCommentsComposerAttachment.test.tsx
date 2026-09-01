import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SelectedTextComment } from "@mcode/contracts";
import { SelectedTextCommentsComposerAttachment } from "./SelectedTextCommentsComposerAttachment";

const comments: SelectedTextComment[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    displayNumber: 1,
    source: {
      threadId: "thread-1",
      messageId: "message-1",
      sourceRole: "assistant",
      start: 0,
      end: 5,
      quote: "First quote",
    },
    note: "First note",
    mentions: [],
  },
];

describe("SelectedTextCommentsComposerAttachment", () => {
  it("shows the prototype attachment label and its saved notes", async () => {
    const user = userEvent.setup();
    render(<SelectedTextCommentsComposerAttachment comments={comments} onRemove={() => {}} />);

    const details = screen.getByRole("button", { name: "1 comment. Details available." });
    expect(screen.getByRole("button", { name: "Remove 1 comment" })).toBeVisible();

    await user.hover(details);

    expect(await screen.findByText("First note")).toBeVisible();
    expect(screen.queryByText("First quote")).toBeNull();
  });

  it("removes the aggregate from the active draft", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(<SelectedTextCommentsComposerAttachment comments={[comments[0]!]} onRemove={onRemove} />);

    await user.click(screen.getByRole("button", { name: "Remove 1 comment" }));

    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
