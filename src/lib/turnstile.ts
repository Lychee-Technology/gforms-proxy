const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** The token itself was rejected — the caller should answer 400. */
export class TurnstileError extends Error {
  errorCodes?: string[];

  constructor(message: string, errorCodes?: string[]) {
    super(message);
    this.name = 'TurnstileError';
    this.errorCodes = errorCodes;
  }
}

/**
 * Verification could not be performed (missing secret, siteverify down or
 * misbehaving) — the caller should answer 503, not blame the token.
 */
export class TurnstileServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnstileServiceError';
  }
}

export async function verifyTurnstile(
  token: string,
  secretKey: string,
  remoteIp?: string,
): Promise<void> {
  if (typeof secretKey !== 'string' || secretKey.trim() === '') {
    console.error('Turnstile configuration error: TURNSTILE_SECRET_KEY is not set');
    throw new TurnstileServiceError('TURNSTILE_SECRET_KEY is not configured');
  }

  const params = new URLSearchParams({ secret: secretKey, response: token });
  if (remoteIp) params.set('remoteip', remoteIp);

  let response: Response;
  try {
    response = await fetch(SITEVERIFY_URL, { method: 'POST', body: params });
  } catch {
    throw new TurnstileServiceError('Network error: could not reach Turnstile siteverify');
  }

  if (!response.ok) {
    throw new TurnstileServiceError(`Turnstile siteverify returned HTTP ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new TurnstileServiceError('Turnstile siteverify returned a non-JSON response');
  }

  // The payload is external input: reject anything that is not an object with
  // a boolean `success`, or a truthy non-boolean would bypass verification.
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    typeof (payload as { success?: unknown }).success !== 'boolean'
  ) {
    throw new TurnstileServiceError('Turnstile siteverify returned an unexpected payload shape');
  }

  const data = payload as { success: boolean; 'error-codes'?: unknown };
  if (!data.success) {
    const rawCodes = data['error-codes'];
    const errorCodes =
      Array.isArray(rawCodes) && rawCodes.every((c): c is string => typeof c === 'string')
        ? rawCodes
        : undefined;
    console.error('Turnstile token verification failed, error-codes:', errorCodes ?? []);
    throw new TurnstileError('Turnstile token verification failed', errorCodes);
  }
}
