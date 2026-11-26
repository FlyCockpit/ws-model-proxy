// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { pickSelectOption } from "@/lib/pick-select-option";

import { LabelledSelect } from "./labelled-select";

function Host() {
  const [value, setValue] = useState<"user" | "admin">("user");
  return (
    <>
      <label htmlFor="role">Role</label>
      <LabelledSelect
        id="role"
        value={value}
        onValueChange={setValue}
        options={[
          { value: "user", label: "Member" },
          { value: "admin", label: "Administrator" },
        ]}
      />
      <output>{value}</output>
    </>
  );
}

afterEach(cleanup);

describe("LabelledSelect", () => {
  it("shows the chosen option's label, never its raw value, and changes on pick", async () => {
    render(<Host />);
    const trigger = screen.getByLabelText("Role");
    expect(trigger.textContent).toContain("Member");
    expect(trigger.textContent).not.toContain("user");
    await pickSelectOption(trigger, "Administrator");
    expect(document.querySelector("output")?.textContent).toBe("admin");
    expect(trigger.textContent).toContain("Administrator");
  });
});
