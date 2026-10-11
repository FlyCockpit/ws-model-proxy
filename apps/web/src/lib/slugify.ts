/** A slug suggestion from a display name (`^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,40}$`). */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 41)
    .replace(/-+$/, "");
}

export const SLUG_PATTERN = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,40}$/;
