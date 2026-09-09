/**
 * Backoff schedule for the seller status screens. A read that answered 2xx with a
 * pending status is repeated after 2 s, then 4 s, 8 s, 16 s and every 30 s; a read that
 * failed (404, 401, 403, network) is never repeated on its own, only by the Refresh
 * control or a page load with the returned=1 or refresh=1 flag.
 */
export const POLL_DELAYS_MS = [2000, 4000, 8000, 16000, 30000] as const;

export function nextPollDelay(attempt: number): number {
  const index = Math.max(0, Math.min(attempt, POLL_DELAYS_MS.length - 1));
  return POLL_DELAYS_MS[index] ?? 30000;
}
