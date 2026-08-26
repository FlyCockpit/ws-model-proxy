/**
 * Wrap a response so commitment is observed at the first non-empty byte of the
 * final client-facing representation, after any protocol adaptation.
 */
export function responseWithFirstClientByte(
  response: Response,
  markFirstClientByte: () => Promise<void> | void,
): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let committed = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          return;
        }
        if (!committed && chunk.value.byteLength > 0) {
          committed = true;
          // Client delivery must never wait on best-effort telemetry I/O.
          void Promise.resolve(markFirstClientByte()).catch(() => undefined);
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
