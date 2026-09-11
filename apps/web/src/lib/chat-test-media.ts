import { env } from "@ws-model-proxy/env/web";

export type UploadMediaResult =
  | { status: "ok"; id: string }
  | { status: "disabled" }
  | { status: "quota" }
  | { status: "tooLarge"; maxBytes?: number }
  | { status: "failed" };

export async function uploadMediaFile(blob: Blob, name: string): Promise<UploadMediaResult> {
  const form = new FormData();
  form.set("file", blob, name);
  try {
    const response = await fetch(`${env.VITE_SERVER_URL}/api/internal/media`, {
      method: "POST",
      credentials: "include",
      body: form,
    });
    if (response.status === 501) return { status: "disabled" };
    if (response.status === 413) {
      const body = (await response.json().catch(() => ({}))) as {
        code?: unknown;
        maxBytes?: unknown;
      };
      if (body.code === "media_quota_exceeded") return { status: "quota" };
      return {
        status: "tooLarge",
        maxBytes:
          typeof body.maxBytes === "number" && body.maxBytes > 0 ? body.maxBytes : undefined,
      };
    }
    if (!response.ok) return { status: "failed" };
    const body: unknown = await response.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "id" in body &&
      typeof body.id === "string" &&
      body.id.length > 0
    )
      return { status: "ok", id: body.id };
    return { status: "failed" };
  } catch {
    return { status: "failed" };
  }
}

export type SignMediaResult =
  | { status: "ok"; urls: Map<string, string> }
  | { status: "expired"; invalidIds: string[] }
  | { status: "failed" };

export async function signMediaUrls(ids: string[]): Promise<SignMediaResult> {
  try {
    const response = await fetch(`${env.VITE_SERVER_URL}/api/internal/media/sign`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (response.status === 403) {
      const body = (await response.json().catch(() => ({}))) as { invalidIds?: unknown };
      const invalidIds = Array.isArray(body.invalidIds)
        ? body.invalidIds.filter((value): value is string => typeof value === "string")
        : ids;
      return { status: "expired", invalidIds: invalidIds.length > 0 ? invalidIds : ids };
    }
    if (!response.ok) return { status: "failed" };
    const body = (await response.json()) as { urls?: unknown };
    const urls = new Map<string, string>();
    if (Array.isArray(body.urls))
      for (const entry of body.urls)
        if (
          entry &&
          typeof entry === "object" &&
          "id" in entry &&
          "url" in entry &&
          typeof entry.id === "string" &&
          typeof entry.url === "string"
        )
          urls.set(entry.id, entry.url);
    return { status: "ok", urls };
  } catch {
    return { status: "failed" };
  }
}
