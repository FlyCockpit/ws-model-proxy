import { openAiErrorBody } from "./openai-errors.js";

/**
 * Reject a declared oversized multipart envelope without reading its body.
 * Chunked bodies deliberately pass through untouched; parseMultipartToSpool
 * enforces the same limit incrementally while preserving backpressure.
 */
export function transcriptionContentLengthGuard(maxBytes: number) {
  return async (
    c: { req: { header(name: string): string | undefined } },
    next: () => Promise<void>,
  ): Promise<Response | undefined> => {
    const raw = c.req.header("content-length");
    if (raw !== undefined) {
      const length = Number(raw);
      if (Number.isFinite(length) && length > maxBytes) {
        return new Response(
          JSON.stringify(
            openAiErrorBody({
              message: "Transcription upload is too large.",
              type: "invalid_request_error",
              code: "request_too_large",
            }),
          ),
          { status: 413, headers: { "content-type": "application/json; charset=utf-8" } },
        );
      }
    }
    await next();
  };
}
