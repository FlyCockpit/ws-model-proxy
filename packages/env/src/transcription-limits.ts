/** Leave room below a 100,000,000-byte proxy body cap for multipart framing. */
export const TRANSCRIPTION_MAX_UPLOAD_BYTES_DEFAULT = 90 * 1024 * 1024;
export const TRANSCRIPTION_MAX_MULTIPART_BYTES_DEFAULT =
  TRANSCRIPTION_MAX_UPLOAD_BYTES_DEFAULT + 1024 * 1024;
