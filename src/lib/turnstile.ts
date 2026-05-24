const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export class TurnstileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnstileError';
  }
}

export async function verifyTurnstile(
  token: string,
  secretKey: string,
  remoteIp?: string,
): Promise<void> {
  const params = new URLSearchParams({ secret: secretKey, response: token });
  if (remoteIp) params.set('remoteip', remoteIp);

  let response: Response;
  try {
    response = await fetch(SITEVERIFY_URL, { method: 'POST', body: params });
  } catch {
    throw new TurnstileError('Network error: could not reach Turnstile siteverify');
  }

  const data = await response.json<{ success: boolean; 'error-codes'?: string[] }>();
  if (!data.success) {
    throw new TurnstileError('Turnstile token verification failed');
  }
}
