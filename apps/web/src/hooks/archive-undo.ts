import { toast } from "@ws-model-proxy/ui/lib/toast";

/**
 * How long the "User archived" toast (and its Undo) stays up. Longer than a
 * plain success toast: the admin has to notice it and reach the button.
 */
export const ARCHIVE_UNDO_TOAST_MS = 8_000;

/**
 * Archiving a user acts at once (no confirm dialog: it is fully reversible),
 * so the success toast carries an Undo that restores the user. Undo calls the
 * same `users.unarchive` as the row's "Restore user" action.
 */
export function announceArchivedWithUndo({
  message,
  undoLabel,
  onUndo,
}: {
  message: string;
  undoLabel: string;
  onUndo: () => void;
}): string {
  return toast.success(message, {
    duration: ARCHIVE_UNDO_TOAST_MS,
    action: { label: undoLabel, onClick: onUndo },
  });
}
