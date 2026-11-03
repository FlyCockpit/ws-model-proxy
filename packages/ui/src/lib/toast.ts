import { sileo } from "sileo";

type ToastOptions = {
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
};

function createToastMethod(method: "success" | "error" | "info" | "warning") {
  return (message: string, options?: ToastOptions) => {
    return sileo[method]({
      title: message,
      ...(options?.duration != null ? { duration: options.duration } : {}),
      ...(options?.action
        ? { button: { title: options.action.label, onClick: options.action.onClick } }
        : {}),
    });
  };
}

export const toast = {
  success: createToastMethod("success"),
  error: createToastMethod("error"),
  info: createToastMethod("info"),
  warning: createToastMethod("warning"),
  dismiss: sileo.dismiss,
  clear: sileo.clear,
};
