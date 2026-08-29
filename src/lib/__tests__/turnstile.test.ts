import { describe, test, expect, vi, afterEach } from 'vitest';
import { verifyTurnstile, TurnstileError, TurnstileServiceError } from '../turnstile.js';

const SECRET = 'test-secret-key';

const siteverifyResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('verifyTurnstile', () => {
  test('resolves when siteverify reports success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(siteverifyResponse({ success: true }));
    await expect(verifyTurnstile('token', SECRET)).resolves.toBeUndefined();
  });

  test('throws TurnstileServiceError without calling siteverify when secret is empty', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(verifyTurnstile('token', '')).rejects.toBeInstanceOf(TurnstileServiceError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('throws TurnstileServiceError without calling siteverify when secret is undefined', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      verifyTurnstile('token', undefined as unknown as string),
    ).rejects.toThrow(/TURNSTILE_SECRET_KEY/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalled();
  });

  test('throws TurnstileServiceError without calling siteverify when secret is whitespace-only', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(verifyTurnstile('token', '   ')).rejects.toBeInstanceOf(TurnstileServiceError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('throws TurnstileServiceError (not TurnstileError) on network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const err = await verifyTurnstile('token', SECRET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TurnstileServiceError);
    expect(err).not.toBeInstanceOf(TurnstileError);
  });

  test('throws TurnstileServiceError on non-OK siteverify response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>503 Service Unavailable</html>', { status: 503 }),
    );
    await expect(verifyTurnstile('token', SECRET)).rejects.toBeInstanceOf(TurnstileServiceError);
  });

  test('throws TurnstileServiceError on non-JSON siteverify response body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not json at all', { status: 200 }),
    );
    await expect(verifyTurnstile('token', SECRET)).rejects.toBeInstanceOf(TurnstileServiceError);
  });

  test('throws TurnstileError and logs error-codes when the token is rejected', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      siteverifyResponse({ success: false, 'error-codes': ['invalid-input-response'] }),
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = await verifyTurnstile('token', SECRET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TurnstileError);
    expect((err as TurnstileError).errorCodes).toEqual(['invalid-input-response']);
    const logged = consoleSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).toContain('invalid-input-response');
  });

  test.each([
    ['JSON null', 'null'],
    ['a JSON array', '[]'],
    ['an object without success', '{}'],
    ['a non-boolean success', '{"success":"false"}'],
  ])('throws TurnstileServiceError when siteverify returns %s', async (_desc, body) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const err = await verifyTurnstile('token', SECRET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TurnstileServiceError);
  });

  test('ignores a malformed error-codes value on token rejection', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      siteverifyResponse({ success: false, 'error-codes': 'not-an-array' }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = await verifyTurnstile('token', SECRET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TurnstileError);
    expect((err as TurnstileError).errorCodes).toBeUndefined();
  });

  test('throws TurnstileError when the token is rejected without an error-codes key', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(siteverifyResponse({ success: false }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = await verifyTurnstile('token', SECRET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TurnstileError);
    expect((err as TurnstileError).errorCodes).toBeUndefined();
  });
});

describe('verifyTurnstile — outbound timeout (#10)', () => {
  test('attaches a live AbortSignal to the siteverify request', async () => {
    let capturedSignal: unknown = undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedSignal = init?.signal;
      return siteverifyResponse({ success: true });
    });

    await verifyTurnstile('token', SECRET);

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect((capturedSignal as AbortSignal).aborted).toBe(false);
  });

  test('surfaces a timeout as TurnstileServiceError, never TurnstileError', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(timeout);

    const err = await verifyTurnstile('token', SECRET).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TurnstileServiceError);
    expect(err).not.toBeInstanceOf(TurnstileError);
    expect((err as Error).message).toMatch(/timed out/i);
  });

  // The deadline stays live through the body read, so the abort can land after
  // the headers arrive. The status was always right, but the message read
  // "non-JSON response", which sends a reader after a payload bug that is not
  // there (PR #33, F1).
  test('names the timeout when the abort lands during the body read', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(timeout),
    } as unknown as Response);

    const err = await verifyTurnstile('token', SECRET).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TurnstileServiceError);
    expect((err as Error).message).toMatch(/timed out/i);
    expect((err as Error).message).not.toMatch(/non-JSON/i);
  });

  test('still reports a genuinely malformed body as a non-JSON response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
    } as unknown as Response);

    const err = await verifyTurnstile('token', SECRET).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TurnstileServiceError);
    expect((err as Error).message).toMatch(/non-JSON/i);
  });
});
