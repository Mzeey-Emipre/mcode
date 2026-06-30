import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../select";

function getFixedInertBackdrops() {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-base-ui-inert][role='presentation']")).filter(
    (element) => element.style.position === "fixed" && element.style.inset === "0px",
  );
}

describe("overlay pointer event boundaries", () => {
  it("keeps dropdown positioners pointer-transparent while content remains interactive", async () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger render={<button type="button">Open</button>} />
        <DropdownMenuContent data-testid="dropdown-content">
          <DropdownMenuItem>Item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    const content = await screen.findByTestId("dropdown-content");
    expect(content.parentElement).toHaveClass("pointer-events-none");
    expect(content).toHaveClass("pointer-events-auto");
  });

  it("keeps dropdown menus from rendering an inert outside backdrop by default", async () => {
    render(
      <>
        <button type="button">Outside target</button>
        <DropdownMenu open>
          <DropdownMenuTrigger render={<button type="button">Open</button>} />
          <DropdownMenuContent data-testid="dropdown-content">
            <DropdownMenuItem>Item</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </>,
    );

    await screen.findByTestId("dropdown-content");
    expect(getFixedInertBackdrops()).toHaveLength(0);
  });

  it("keeps popover positioners pointer-transparent while content remains interactive", async () => {
    render(
      <Popover open>
        <PopoverTrigger render={<button type="button">Open</button>} />
        <PopoverContent data-testid="popover-content">Content</PopoverContent>
      </Popover>,
    );

    const content = await screen.findByTestId("popover-content");
    expect(content.parentElement).toHaveClass("pointer-events-none");
    expect(content).toHaveClass("pointer-events-auto");
  });

  it("keeps select popups from rendering an inert outside backdrop by default", async () => {
    render(
      <>
        <button type="button">Outside target</button>
        <Select open defaultValue="one">
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent data-testid="select-content">
            <SelectItem value="one">One</SelectItem>
          </SelectContent>
        </Select>
      </>,
    );

    await screen.findByTestId("select-content");
    expect(getFixedInertBackdrops()).toHaveLength(0);
  });
});
