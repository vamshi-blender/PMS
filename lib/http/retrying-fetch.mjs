// Plain JavaScript: shared by the backend and the Node release-publishing script.
const RETRY_DELAYS_MS = [250, 750];
const NEVER_CONNECTED_CODES = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT",
]);

function neverConnected(error) {
  const cause = error?.cause;
  return cause && (NEVER_CONNECTED_CODES.has(cause.code ?? "") ||
    (cause.code === "ECONNRESET" && /before secure TLS connection was established/.test(cause.message ?? "")));
}

/**
 * Reads can retry network failures. Writes retry only if no connection was
 * established, so an uncertain upload or database write is never repeated.
 * HTTP errors (authentication, quota, missing object) are returned unchanged.
 * @type {typeof fetch}
 */
export const retryingFetch = async (input, init) => {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(input, init);
    } catch (error) {
      const retryable = error instanceof TypeError && !init?.signal?.aborted &&
        (method === "GET" || method === "HEAD" || neverConnected(error));
      if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw error;
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
};
