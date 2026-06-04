import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanRecord } from "@mcode/contracts";
import { PlanDocument, type PlanComment } from "./PlanDocument";

const makePlan = (contentMd: string): PlanRecord => ({
  id: "plan-1",
  threadId: "thread-plan",
  messageId: "00000000-0000-4000-8000-000000000001",
  version: 1,
  title: "Plan",
  contentMd,
  sectionsJson: [{ id: "section-1", title: "Issues Found", level: 2 }],
  changeSummary: null,
  status: "draft",
  createdAt: "2026-05-23T00:00:01.000Z",
});

const PLACEHOLDER = "What should change in this section?";

describe("PlanDocument annotation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const openEditor = async () => {
    const onCommentChange = vi.fn();
    const onCommentDiscard = vi.fn();
    render(
      <PlanDocument
        plan={makePlan("## Issues Found\n\nSome body text.")}
        comments={[] as PlanComment[]}
        onCommentChange={onCommentChange}
        onCommentDiscard={onCommentDiscard}
      />,
    );
    // MarkdownContent is lazy-loaded (Shiki); allow extra time for the chunk
    // to resolve under the full parallel suite before the heading appears.
    const heading = await screen.findByText("Issues Found", {}, { timeout: 5000 });
    fireEvent.click(heading);
    const textarea = await screen.findByPlaceholderText(PLACEHOLDER, {}, { timeout: 5000 });
    return { textarea, onCommentChange, onCommentDiscard };
  };

  it("stashes the draft AND closes the editor when the user clicks away", async () => {
    const { textarea, onCommentChange } = await openEditor();

    fireEvent.change(textarea, { target: { value: "tighten the intro" } });
    fireEvent.blur(textarea);

    // Draft is stashed against the section.
    expect(onCommentChange).toHaveBeenCalledWith("Issues Found", "tighten the intro");
    // Editor collapses on click-away rather than lingering open.
    await waitFor(
      () => {
        expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull();
      },
      { timeout: 5000 },
    );
  });

  it("discards an empty draft and closes when the user clicks away", async () => {
    const { textarea, onCommentChange, onCommentDiscard } = await openEditor();

    fireEvent.blur(textarea);

    expect(onCommentChange).not.toHaveBeenCalled();
    expect(onCommentDiscard).toHaveBeenCalledWith("Issues Found");
    await waitFor(
      () => {
        expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull();
      },
      { timeout: 5000 },
    );
  });
});
