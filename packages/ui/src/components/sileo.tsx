import { Toaster as SileoToaster } from "sileo";
import "sileo/styles.css";

import { invokeToastAction } from "./toast-action";

interface ToasterProps {
  position?:
    | "top-left"
    | "top-center"
    | "top-right"
    | "bottom-left"
    | "bottom-center"
    | "bottom-right";
}

// No `theme`: sileo's themes invert the page (a light pill on a dark app). The
// toast takes the app's popover tokens from globals.css instead, so it follows
// `.dark` like every other surface, with no JS theme state.
const Toaster = ({ position = "bottom-center", ...props }: ToasterProps) => (
  <div
    style={{ display: "contents" }}
    onClick={(event) => {
      const toastEl = (event.target as Element | null)?.closest("[data-sileo-toast]");
      if (!toastEl || toastEl.getAttribute("data-exiting") === "true") return;
      const actionId = toastEl
        .querySelector("[data-toast-action-id]")
        ?.getAttribute("data-toast-action-id");
      if (!actionId) return;
      event.preventDefault();
      event.stopPropagation();
      invokeToastAction(actionId);
    }}
  >
    <SileoToaster position={position} {...props} />
  </div>
);

export { Toaster };
