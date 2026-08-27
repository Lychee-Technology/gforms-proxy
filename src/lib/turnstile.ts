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
  if (typeof secretKey !== 'string' || secretKey === '') {
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

  let data: { success: boolean; 'error-codes'?: string[] };
  try {
    data = await response.json<{ success: boolean; 'error-codes'?: string[] }>();
  } catch {
    throw new TurnstileServiceError('Turnstile siteverify returned a non-JSON response');
  }

  if (!data.success) {
    const errorCodes = data['error-codes'];
    console.error('Turnstile token verification failed, error-codes:', errorCodes ?? []);
    throw new TurnstileError('Turnstile token verification failed', errorCodes);
  }
}
