import { Toaster as SileoToaster } from "sileo";
import "sileo/styles.css";

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
  <SileoToaster position={position} {...props} />
);

export { Toaster };
