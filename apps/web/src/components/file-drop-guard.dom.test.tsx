// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFileDropTarget } from "@/hooks/use-file-drop-target";

const notice = vi.hoisted(() => vi.fn());
vi.mock("@ws-model-proxy/ui/lib/toast", () => ({ toast: { info: notice } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { FileDropGuard } from "./file-drop-guard";

function drag(target: EventTarget, type: string, types = ["Files"]) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const dataTransfer = {
    types,
    files: [new File(["image"], "image.png", { type: "image/png" })],
    dropEffect: "move",
  };
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  target.dispatchEvent(event);
  return { event, dataTransfer };
}
function Zone({
  onFiles,
  children,
}: {
  onFiles: (files: File[]) => void;
  children?: React.ReactNode;
}) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  useFileDropTarget(element, onFiles);
  return (
    <div ref={setElement} data-testid="zone">
      {children ?? <span>Drop here</span>}
    </div>
  );
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FileDropGuard", () => {
  it("prevents unclaimed file navigation and shows a neutral notice", () => {
    render(<FileDropGuard />);
    const over = drag(document.body, "dragover");
    expect(over.event.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe("none");
    expect(drag(document.body, "drop").event.defaultPrevented).toBe(true);
    expect(notice).toHaveBeenCalledWith("fileDrop.ignored");
  });
  it("leaves ordinary link and text drags alone", () => {
    render(<FileDropGuard />);
    expect(drag(document.body, "dragover", ["text/uri-list"]).event.defaultPrevented).toBe(false);
    expect(drag(document.body, "drop", ["text/plain"]).event.defaultPrevented).toBe(false);
    expect(notice).not.toHaveBeenCalled();
  });
  it("dispatches exactly once to the innermost registered zone", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    const view = render(
      <>
        <FileDropGuard />
        <Zone onFiles={outer}>
          <Zone onFiles={inner} />
        </Zone>
      </>,
    );
    const target = view.getByText("Drop here");
    expect(drag(target, "dragover").dataTransfer.dropEffect).toBe("copy");
    drag(target, "drop");
    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner.mock.calls[0]?.[0][0].name).toBe("image.png");
    expect(outer).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
  });
  it("unregisters removed targets and removes document listeners on unmount", () => {
    const files = vi.fn();
    const view = render(
      <>
        <FileDropGuard />
        <Zone onFiles={files} />
      </>,
    );
    const target = view.getByTestId("zone");
    view.rerender(<FileDropGuard />);
    document.body.append(target);
    drag(target, "drop");
    expect(files).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(drag(document.body, "drop").event.defaultPrevented).toBe(false);
    target.remove();
  });
  it("leaves drops already claimed by an existing handler alone", () => {
    const view = render(
      <>
        <FileDropGuard />
        <div>existing target</div>
      </>,
    );
    const target = view.getByText("existing target");
    const claim = (event: Event) => event.preventDefault();
    target.addEventListener("dragover", claim);
    target.addEventListener("drop", claim);
    expect(drag(target, "dragover").dataTransfer.dropEffect).toBe("move");
    drag(target, "drop");
    expect(notice).not.toHaveBeenCalled();
  });
  it("preserves the terminal's own image drop handler without a toast or second dispatch", () => {
    const view = render(
      <>
        <FileDropGuard />
        <div className="xterm">
          <span>terminal</span>
        </div>
      </>,
    );
    const target = view.getByText("terminal");
    const handled = vi.fn();
    target.addEventListener("drop", handled);
    expect(drag(target, "dragover").event.defaultPrevented).toBe(false);
    drag(target, "drop");
    expect(handled).toHaveBeenCalledTimes(1);
    expect(notice).not.toHaveBeenCalled();
  });
});
