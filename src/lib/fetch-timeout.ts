// A Worker request has a bounded wall-clock budget, and an upstream that
// accepts a connection but never answers would burn all of it before the
// runtime gives up. Every outbound fetch this project makes therefore carries
// the same abort deadline (#10).
//
// One shared constant rather than three call-site literals: the point is that
// the three values cannot drift apart by accident. If the build-time generator
// ever wants a longer budget than the Worker, that is a second named constant,
// deliberately introduced.
export const FETCH_TIMEOUT_MS = 10_000;

/**
 * True when a rejection came from our own timeout signal rather than from the
 * network. `AbortSignal.timeout` aborts with a `TimeoutError`, but a runtime
 * that reports the generic abort instead of propagating the signal's reason
 * yields `AbortError`; both mean the same thing here, because that signal is
 * the only one attached to these fetches.
 *
 * Callers use this only to pick a clearer message — a timeout still maps to
 * the same error class, and so to the same HTTP status, as any other failure
 * to reach the upstream.
 */
export function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}
