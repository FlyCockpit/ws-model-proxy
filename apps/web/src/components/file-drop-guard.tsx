import { useFileDropGuard } from "@/hooks/use-file-drop-guard";

/** Swallow unclaimed OS-file drops on every page without uploading them. */
export function FileDropGuard() {
  useFileDropGuard();
  return null;
}
