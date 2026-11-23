import { openAiErrorBody } from "./openai-errors.js";

/**
 * The 413 message for a transcription/translation upload over this server's
 * caps. It names both limits so a client (or the person reading its error) can
 * split or compress the audio instead of retrying the same file.
 */
export function transcriptionUploadTooLargeMessage(limits: {
  maxMultipartBytes: number;
  maxFileBytes: number;
}): string {
  return (
    `Transcription upload is too large: this server accepts requests up to ${limits.maxMultipartBytes} bytes ` +
    `with an audio file up to ${limits.maxFileBytes} bytes. Split or compress the audio and send each part separately.`
  );
}

/**
 * Reject a declared oversized multipart envelope without reading its body.
 * Chunked bodies deliberately pass through untouched; parseMultipartToSpool
 * enforces the same limit incrementally while preserving backpressure.
 */
export function transcriptionContentLengthGuard(limits: {
  maxMultipartBytes: number;
  maxFileBytes: number;
}) {
  return async (
    c: { req: { header(name: string): string | undefined } },
    next: () => Promise<void>,
  ): Promise<Response | undefined> => {
    const raw = c.req.header("content-length");
    if (raw !== undefined) {
      const length = Number(raw);
      if (Number.isFinite(length) && length > limits.maxMultipartBytes) {
        return new Response(
          JSON.stringify(
            openAiErrorBody({
              message: transcriptionUploadTooLargeMessage(limits),
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
