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

  test('throws TurnstileError when the token is rejected without an error-codes key', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(siteverifyResponse({ success: false }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = await verifyTurnstile('token', SECRET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TurnstileError);
    expect((err as TurnstileError).errorCodes).toBeUndefined();
  });
});
