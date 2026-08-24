import { type ModelApiSurface, modelApiSurfaces } from "./surface-capabilities";

export function parseModelApiSurface(value: unknown): ModelApiSurface | null {
  if (typeof value !== "string") return null;
  return modelApiSurfaces.find((surface) => surface === value) ?? null;
}
