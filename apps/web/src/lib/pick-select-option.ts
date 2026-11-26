import { fireEvent, screen } from "@testing-library/react";

/**
 * Test helper: open a Base UI select (`LabelledSelect`) and pick the option named `name`, with
 * the pointer sequence Base UI listens for (a bare click does not select in jsdom).
 */
export async function pickSelectOption(trigger: HTMLElement, name: string | RegExp) {
  fireEvent.click(trigger);
  const option = await screen.findByRole("option", { name });
  fireEvent.pointerDown(option);
  fireEvent.mouseDown(option);
  fireEvent.pointerUp(option);
  fireEvent.mouseUp(option);
  fireEvent.click(option);
}
