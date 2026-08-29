import { describe, test, expect } from 'vitest';
import { FETCH_TIMEOUT_MS, isTimeoutError } from '../fetch-timeout.js';

describe('FETCH_TIMEOUT_MS', () => {
  test('is the uniform 10s budget every outbound fetch shares', () => {
    expect(FETCH_TIMEOUT_MS).toBe(10_000);
  });
});

describe('isTimeoutError', () => {
  test('recognizes the TimeoutError AbortSignal.timeout aborts with', () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    expect(isTimeoutError(err)).toBe(true);
  });

  // Our timeout signal is the only signal attached to these fetches, so an
  // AbortError can only mean the same thing on a runtime that reports it that
  // way instead of propagating the signal's TimeoutError reason.
  test('treats AbortError as a timeout too', () => {
    const err = new Error('This operation was aborted');
    err.name = 'AbortError';
    expect(isTimeoutError(err)).toBe(true);
  });

  test('rejects an ordinary network failure', () => {
    expect(isTimeoutError(new TypeError('fetch failed'))).toBe(false);
  });

  test('rejects non-Error values', () => {
    expect(isTimeoutError(null)).toBe(false);
    expect(isTimeoutError(undefined)).toBe(false);
    expect(isTimeoutError('TimeoutError')).toBe(false);
    expect(isTimeoutError({ name: 'TimeoutError' })).toBe(false);
  });
});
