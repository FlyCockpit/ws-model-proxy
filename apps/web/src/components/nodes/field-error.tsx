/** The first message of a TanStack Form field's errors (zod issues or strings). */
export function FieldError({
  errors,
  id,
}: {
  errors: ReadonlyArray<{ message?: string } | string | undefined | null>;
  /** For the input's `aria-describedby`. */
  id?: string;
}) {
  const message = errors
    .map((error) => (typeof error === "string" ? error : error?.message))
    .find(Boolean);
  return message ? (
    <p id={id} className="text-sm text-destructive">
      {message}
    </p>
  ) : null;
}

/** `aria-invalid` and `aria-describedby` for an input whose error renders as `FieldError` `id`. */
export function invalidProps(
  errors: ReadonlyArray<unknown>,
  id: string,
): { "aria-invalid"?: true; "aria-describedby"?: string } {
  return errors.some(Boolean) ? { "aria-invalid": true, "aria-describedby": id } : {};
}
