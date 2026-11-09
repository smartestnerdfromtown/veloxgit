/**
 * Best-effort connectivity helpers. Electron keeps `navigator.onLine`
 * current; anonymous/unknown environments are treated as online so the
 * plugin never blocks Git on a missing signal.
 */
export function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

const NETWORK_ERROR_PATTERN =
  /(could not resolve host|failed to connect|couldn't connect|connection (?:timed out|refused|reset|closed)|network is unreachable|no route to host|temporary failure in name resolution|ssh: connect to host|timed out|unable to access|early eof|ssl_connect|ssl_error)/i;

/** Distinguishes "remote unreachable" from real Git errors (auth, reject). */
export function isNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return NETWORK_ERROR_PATTERN.test(message);
}
