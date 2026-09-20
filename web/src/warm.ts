/**
 * Wake a service that sleeps between uses. It sends one cheap request to the service's `/healthz` and does
 * not care what comes back: the point is only that the service has started by the time it is needed. Returns
 * true if it answered, false if there is no address or it did not answer (never throws).
 *
 * The address comes from `VITE_TITILER_URL` and is not in the repository. Meant to be temporary: drop it once
 * the service no longer sleeps.
 */
export async function warmUp(baseUrl: string | undefined, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!baseUrl) return false;
  try {
    // A service that is waking can take a while, so allow it, but not for ever.
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/healthz`, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
    return response.ok;
  } catch {
    return false;
  }
}
