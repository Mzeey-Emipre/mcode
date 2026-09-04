import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionRequestCard } from "./PermissionRequestCard";

const { respondToPermission } = vi.hoisted(() => ({
  respondToPermission: vi.fn(async () => undefined),
}));

vi.mock("@/transport", () => ({
  getTransport: () => ({ respondToPermission }),
}));

const questions = [
  {
    header: "Deploy",
    question: "Deploy now?",
    options: [{ label: "Yes" }, { label: "No" }],
    multiple: false,
    custom: false,
  },
  {
    header: "Regions",
    question: "Choose regions",
    options: [{ label: "East" }, { label: "West" }],
    multiple: true,
    custom: false,
  },
  {
    header: "Notes",
    question: "Anything else?",
    options: [],
    multiple: false,
    custom: true,
  },
];

function renderQuestionCard() {
  render(
    <PermissionRequestCard
      requestId="que_1"
      toolName="Question"
      input={{}}
      title="Questions"
      questions={questions}
      settled={false}
    />,
  );
}

describe("PermissionRequestCard question flow", () => {
  beforeEach(() => {
    respondToPermission.mockClear();
  });

  it("collects single, multiple, and custom answers without offering session approval", async () => {
    const user = userEvent.setup();
    renderQuestionCard();
    await waitFor(() => expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled());

    expect(screen.getByRole("button", { name: "Submit answers" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Change allow mode" })).not.toBeInTheDocument();
    expect(screen.queryByText("Allow in session")).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Yes" }));
    await user.click(screen.getByRole("checkbox", { name: "East" }));
    await user.click(screen.getByRole("checkbox", { name: "West" }));
    await user.type(screen.getByRole("textbox", { name: "Custom answer for Notes" }), "ship after review");
    await user.click(screen.getByRole("button", { name: "Submit answers" }));

    expect(respondToPermission).toHaveBeenCalledWith(
      "que_1",
      "allow",
      [["Yes"], ["East", "West"], ["ship after review"]],
    );
  });

  it("rejects a question through the normal deny action", async () => {
    const user = userEvent.setup();
    renderQuestionCard();
    await waitFor(() => expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled());

    await user.click(screen.getByRole("button", { name: "Deny" }));

    expect(respondToPermission).toHaveBeenCalledWith("que_1", "deny");
  });

  it("keeps same-index radio answers independent across simultaneous cards", async () => {
    const user = userEvent.setup();
    render(
      <>
        <PermissionRequestCard requestId="que_1" toolName="Question" input={{}} questions={questions} settled={false} />
        <PermissionRequestCard requestId="que_2" toolName="Question" input={{}} questions={questions} settled={false} />
      </>,
    );
    const yesOptions = screen.getAllByRole("radio", { name: "Yes" });
    await waitFor(() => expect(yesOptions.every((option) => !option.hasAttribute("disabled"))).toBe(true));

    await user.click(yesOptions[0]!);
    await user.click(yesOptions[1]!);

    expect(yesOptions[0]).toBeChecked();
    expect(yesOptions[1]).toBeChecked();
  });
});
