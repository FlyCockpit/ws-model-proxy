/** The first validation message of a TanStack Form field, if any. */
export function FieldErrors({
  field,
}: {
  field: { state: { meta: { errors: Array<{ message?: string } | string | undefined> } } };
}) {
  const first = field.state.meta.errors.reduce<string | null>((found, error) => {
    if (found) return found;
    const message = typeof error === "string" ? error : error?.message;
    return message ?? null;
  }, null);
  if (!first) return null;
  return <p className="text-sm text-destructive">{first}</p>;
}
