// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { focusFirstInvalid } from "./form-surface";

afterEach(cleanup);

describe("focusFirstInvalid", () => {
  it("opens the collapsed sections around the first invalid input and focuses it", () => {
    const { container } = render(
      <form>
        <input id="ok" />
        <details>
          <summary>Advanced</summary>
          <details>
            <summary>Inner</summary>
            <input id="bad" aria-invalid="true" />
          </details>
        </details>
        <input id="later" aria-invalid="true" />
      </form>,
    );
    expect(focusFirstInvalid(container)).toBe(true);
    expect(document.activeElement?.id).toBe("bad");
    for (const details of container.querySelectorAll("details")) expect(details.open).toBe(true);
  });

  it("falls back to an error no input owns, so it is never left inside a closed section", () => {
    const { container } = render(
      <form>
        <details>
          <summary>Commands</summary>
          <p data-inline-error="" tabIndex={-1} id="list-error">
            Two command entries for a group of three.
          </p>
        </details>
      </form>,
    );
    expect(focusFirstInvalid(container)).toBe(true);
    expect(document.activeElement?.id).toBe("list-error");
    expect(container.querySelector("details")?.open).toBe(true);
  });

  it("does nothing when nothing is invalid", () => {
    const { container } = render(
      <form>
        <input />
      </form>,
    );
    expect(focusFirstInvalid(container)).toBe(false);
  });
});
