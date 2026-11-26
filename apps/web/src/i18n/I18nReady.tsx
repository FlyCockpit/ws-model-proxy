import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ShellSkeleton } from "@/components/shell-skeleton";

export function I18nReady({ children }: { children: ReactNode }) {
  const { ready } = useTranslation();
  // A locale bundle still loading: the shell's frame, as the document showed before this rendered.
  if (!ready) return <ShellSkeleton />;
  return <>{children}</>;
}
