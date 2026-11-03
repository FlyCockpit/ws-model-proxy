/** `m:ss` (or `h:mm:ss`) left until `expiresAt`; null once it passed. */
export function countdownText(expiresAt: string, now: number): string | null {
  const left = Math.floor((new Date(expiresAt).getTime() - now) / 1000);
  if (!(left > 0)) return null;
  const hours = Math.floor(left / 3600);
  const minutes = Math.floor((left % 3600) / 60);
  const seconds = String(left % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}
