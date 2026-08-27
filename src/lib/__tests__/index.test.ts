import { describe, test, expect, vi, afterEach } from 'vitest';
import type { FormDefinition } from '../types.js';

const MOCK_DEFINITION: FormDefinition = {
  formId: 'testForm123',
  submissionUrl: 'https://docs.google.com/forms/d/e/testForm123/formResponse',
  schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1 },
    },
  },
  fieldMap: { name: 'entry.999' },
};

// Generator-compatible Turnstile definition: mirrors what
// gen-field-mapping.ts emits for --turnstile forms (turnstile_token spliced
// into properties and required, additionalProperties false).
const MOCK_TURNSTILE_DEFINITION: FormDefinition = {
  formId: 'turnstileForm',
  submissionUrl: 'https://docs.google.com/forms/d/e/turnstileForm/formResponse',
  schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['name', 'turnstile_token'],
    properties: {
      name: { type: 'string', minLength: 1 },
      turnstile_token: { type: 'string', description: 'Cloudflare Turnstile token' },
    },
  },
  fieldMap: { name: 'entry.111' },
  turnstileEnabled: true,
};

// ADVERSARIAL FIXTURE — deliberately violates the FormDefinition invariant
// documented in AGENTS.md (Turnstile-enabled schemas require turnstile_token,
// spliced by the generator). It models schema drift so the endpoint's own
// token guard is exercised without the validator rejecting the request first.
// Never copy this shape for a real registered form.
const DRIFTED_TURNSTILE_DEFINITION: FormDefinition = {
  formId: 'driftedTurnstileForm',
  submissionUrl: 'https://docs.google.com/forms/d/e/driftedTurnstileForm/formResponse',
  schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: true,
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1 },
    },
  },
  fieldMap: { name: 'entry.111' },
  turnstileEnabled: true,
};

vi.mock('../../forms/registry.js', () => ({
  default: new Map([
    ['testForm123', MOCK_DEFINITION],
    ['turnstileForm', MOCK_TURNSTILE_DEFINITION],
    ['driftedTurnstileForm', DRIFTED_TURNSTILE_DEFINITION],
  ]),
}));

// Import app AFTER mocking the registry
const { default: app } = await import('../../index.js');

afterEach(() => { vi.restoreAllMocks(); });

describe('POST /api/v1/forms/:formId/responses', () => {
  test('returns 404 for unknown formId', async () => {
    const res = await app.request('/api/v1/forms/unknown/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice' }),
    });
    expect(res.status).toBe(404);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('Form not found');
  });

  test('returns 400 for invalid JSON body', async () => {
    const res = await app.request('/api/v1/forms/testForm123/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('Invalid JSON body');
  });

  test('returns 400 with details for schema validation failure', async () => {
    const res = await app.request('/api/v1/forms/testForm123/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extra: 'bad' }),
    });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string; details: unknown[] };
    expect(json.error).toBe('Validation failed');
    expect(Array.isArray(json.details)).toBe(true);
    expect(json.details.length).toBeGreaterThan(0);
  });

  test('returns 200 success on valid submission', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));
    const res = await app.request('/api/v1/forms/testForm123/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice' }),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean };
    expect(json.success).toBe(true);
  });

  test('returns 502 when Google Forms submission fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    const res = await app.request('/api/v1/forms/testForm123/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice' }),
    });
    expect(res.status).toBe(502);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('Failed to submit to Google Forms');
  });
});

describe('POST /api/v1/forms/:formId/responses (Turnstile-enabled form)', () => {
  const ENV = { TURNSTILE_SECRET_KEY: 'test-secret' };

  const post = (body: unknown, env: Record<string, unknown> = ENV, formId = 'turnstileForm') =>
    app.request(
      `/api/v1/forms/${formId}/responses`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      env,
    );

  // The token-guard tests use the drifted definition: with the
  // generator-compatible schema the validator would reject the request first,
  // so drift is the only path that reaches the endpoint's own guard.
  const postDrifted = (body: unknown) => post(body, ENV, 'driftedTurnstileForm');

  test('returns 400 naming turnstile_token when it is missing, without calling siteverify', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await postDrifted({ name: 'Alice' });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toContain('turnstile_token');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('returns 400 naming turnstile_token when it is an empty string', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await postDrifted({ name: 'Alice', turnstile_token: '' });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toContain('turnstile_token');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('returns 400 naming turnstile_token when it is not a string', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await postDrifted({ name: 'Alice', turnstile_token: 12345 });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toContain('turnstile_token');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('returns 503 when TURNSTILE_SECRET_KEY is not configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post({ name: 'Alice', turnstile_token: 'tok' }, {});
    expect(res.status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('returns 503 when siteverify is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post({ name: 'Alice', turnstile_token: 'tok' });
    expect(res.status).toBe(503);
  });

  test('returns 503 when siteverify returns a non-OK response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>503</html>', { status: 503 }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post({ name: 'Alice', turnstile_token: 'tok' });
    expect(res.status).toBe(503);
  });

  test('returns 400 when siteverify rejects the token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post({ name: 'Alice', turnstile_token: 'bad-tok' });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('Turnstile verification failed');
  });

  test('submits to Google Forms when the token verifies', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('challenges.cloudflare.com')) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('', { status: 200 });
    });
    const res = await post({ name: 'Alice', turnstile_token: 'good-tok' });
    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean };
    expect(json.success).toBe(true);
  });
});
