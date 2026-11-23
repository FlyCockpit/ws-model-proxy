// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogTitle,
} from "@ws-model-proxy/ui/components/alert-dialog";
import { afterEach, expect, it } from "vitest";
import { SegmentedControl } from "./segmented-control";

afterEach(cleanup);

// Touch targets are at least 44px on both axes (AGENTS.md), even for a short label like "All".
it("gives every segment a 44px minimum box", () => {
  render(
    <SegmentedControl
      value="all"
      onChange={() => {}}
      items={[
        { value: "all", label: "All" },
        { value: "ok", label: "OK" },
      ]}
    />,
  );
  for (const name of ["All", "OK"]) {
    const segment = screen.getByRole("button", { name });
    expect(segment.classList.contains("min-h-[44px]")).toBe(true);
    expect(segment.classList.contains("min-w-[44px]")).toBe(true);
  }
});

it("gives AlertDialogCancel a 44px minimum box by default, keeping caller classes", () => {
  render(
    <AlertDialog defaultOpen>
      <AlertDialogContent>
        <AlertDialogTitle>Delete?</AlertDialogTitle>
        <AlertDialogCancel className="w-full">Cancel</AlertDialogCancel>
      </AlertDialogContent>
    </AlertDialog>,
  );
  const cancel = screen.getByRole("button", { name: "Cancel" });
  for (const className of ["min-h-11", "min-w-11", "w-full"])
    expect(cancel.classList.contains(className)).toBe(true);
});
