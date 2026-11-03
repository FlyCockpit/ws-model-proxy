import { useTheme } from "next-themes";
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

const Toaster = ({ position = "bottom-center", ...props }: ToasterProps) => {
  const { resolvedTheme } = useTheme();

  return (
    <SileoToaster
      theme={(resolvedTheme as "light" | "dark") ?? "system"}
      position={position}
      {...props}
    />
  );
};

export { Toaster };
