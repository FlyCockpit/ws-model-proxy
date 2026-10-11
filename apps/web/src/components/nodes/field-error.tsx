/** The first message of a TanStack Form field's errors (zod issues or strings). */
export function FieldError({
  errors,
}: {
  errors: ReadonlyArray<{ message?: string } | string | undefined | null>;
}) {
  const message = errors
    .map((error) => (typeof error === "string" ? error : error?.message))
    .find(Boolean);
  return message ? <p className="text-sm text-destructive">{message}</p> : null;
}
