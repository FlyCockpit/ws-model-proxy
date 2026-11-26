import { leaveDocument, markExplicitSignOut } from "@/lib/document-identity";

export type ExplicitSignOutResult = { ok: true } | { ok: false; error: unknown };

/**
 * The one explicit sign-out: mark it (so the identity watcher leaves the page
 * load to it), sign out, and on success load `href` (the sign-in page) as a new,
 * quarantined document (`leaveDocument`); without `href`, the current URL is
 * reloaded as it is (the MCP login page's reauthorization). A failure,
 * returned or thrown, undoes the mark (still signed in here; if the identity
 * changed meanwhile anyway, the undo replaces the document) and is returned
 * for the caller's feedback. `disableRedirect` is Better Auth's sign-out body
 * flag. docs/ui.md § Query cache follows identity.
 */
export async function signOutAndLeave(
  href?: string,
  options: { disableRedirect?: boolean } = {},
): Promise<ExplicitSignOutResult> {
  // Dynamic import keeps the sign-out path out of its callers' chunks; the
  // auth client is already warm once a signed-in page offers it.
  const { authClient } = await import("@/lib/auth-client");
  const undo = markExplicitSignOut();
  try {
    const result = await authClient.signOut({
      ...options,
      fetchOptions: { onSuccess: () => leaveDocument(href) },
    });
    if (!result.error) return { ok: true };
    undo();
    return { ok: false, error: result.error };
  } catch (error) {
    undo();
    return { ok: false, error };
  }
}
