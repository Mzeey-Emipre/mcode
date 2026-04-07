import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ThreadTitleEditor } from "./ThreadTitleEditor";

describe("ThreadTitleEditor", () => {
  const mockOnSave = vi.fn();
  const mockOnCancel = vi.fn();

  beforeEach(() => {
    mockOnSave.mockClear();
    mockOnCancel.mockClear();
  });

  it("renders as a static span when not editing", () => {
    render(
      <ThreadTitleEditor
        title="Test Thread"
        isEditing={false}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );
    expect(screen.getByText("Test Thread")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("renders as an input when editing is true", () => {
    render(
      <ThreadTitleEditor
        title="Test Thread"
        isEditing={true}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.value).toBe("Test Thread");
  });

  it("calls onSave with new title when Enter is pressed", async () => {
    const user = userEvent.setup();
    render(
      <ThreadTitleEditor
        title="Test Thread"
        isEditing={true}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "New Title");
    await user.keyboard("{Enter}");
    expect(mockOnSave).toHaveBeenCalledWith("New Title");
  });

  it("calls onSave with new title when input loses focus", async () => {
    const user = userEvent.setup();
    render(
      <ThreadTitleEditor
        title="Test Thread"
        isEditing={true}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "New Title");
    input.blur();
    expect(mockOnSave).toHaveBeenCalledWith("New Title");
  });

  it("calls onCancel when Escape is pressed", async () => {
    const user = userEvent.setup();
    render(
      <ThreadTitleEditor
        title="Test Thread"
        isEditing={true}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );
    await user.keyboard("{Escape}");
    expect(mockOnCancel).toHaveBeenCalled();
  });

  it("selects all text in input when editing starts", () => {
    const { rerender } = render(
      <ThreadTitleEditor
        title="Test Thread"
        isEditing={false}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );
    rerender(
      <ThreadTitleEditor
        title="Test Thread"
        isEditing={true}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("Test Thread".length);
  });

  it("does not save empty titles", async () => {
    const user = userEvent.setup();
    render(
      <ThreadTitleEditor
        title="Test Thread"
        isEditing={true}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.keyboard("{Enter}");
    expect(mockOnSave).not.toHaveBeenCalled();
  });

  it("does not call onSave twice when Enter is pressed", async () => {
    const user = userEvent.setup();
    render(
      <ThreadTitleEditor
        title="Test Thread"
        isEditing={true}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "New Title");
    await user.keyboard("{Enter}");
    // Verify onSave was called exactly once, not twice
    expect(mockOnSave).toHaveBeenCalledTimes(1);
    expect(mockOnSave).toHaveBeenCalledWith("New Title");
  });

  it("does not call onSave after Escape is pressed", async () => {
    const user = userEvent.setup();
    render(
      <ThreadTitleEditor
        title="Test Thread"
        isEditing={true}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "New Title");
    await user.keyboard("{Escape}");
    // onCancel should be called, but not onSave
    expect(mockOnCancel).toHaveBeenCalled();
    expect(mockOnSave).not.toHaveBeenCalled();
  });
});
