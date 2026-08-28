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

// ADVERSARIAL FIXTURE — a mapped field with no declared type, so the validator
// lets an object value through to the submitter. scripts/field-support.ts
// rejects the field types that produce object values before a real definition
// is ever written, so this drift is the only way to exercise the submitter's
// own object-value guard through the route. Never copy this shape.
const UNTYPED_FIELD_DEFINITION: FormDefinition = {
  formId: 'untypedFieldForm',
  submissionUrl: 'https://docs.google.com/forms/d/e/untypedFieldForm/formResponse',
  schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['grid_answer'],
    properties: {
      grid_answer: {},
    },
  },
  fieldMap: { grid_answer: 'entry.333' },
};

vi.mock('../../forms/registry.js', () => ({
  default: new Map([
    ['testForm123', MOCK_DEFINITION],
    ['turnstileForm', MOCK_TURNSTILE_DEFINITION],
    ['driftedTurnstileForm', DRIFTED_TURNSTILE_DEFINITION],
    ['untypedFieldForm', UNTYPED_FIELD_DEFINITION],
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

  test('returns 502 when Google Forms fails on its own side', async () => {
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

  test('returns 502 when Google Forms cannot be reached', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'));
    const res = await app.request('/api/v1/forms/testForm123/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice' }),
    });
    expect(res.status).toBe(502);
  });

  test('returns 400 when Google Forms rejects the submission', async () => {
    // Google validates server-side and answers 400 for a violated rule; that
    // is a client error, not an upstream failure (ADR 0006).
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>', { status: 400 }));
    const res = await app.request('/api/v1/forms/testForm123/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice' }),
    });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toContain('Google Forms rejected the submission');
    expect(json.error).toContain('validation rules');
  });

  test('returns 400 when Google Forms answers 413 for an over-large payload', async () => {
    // Payload-too-large is the caller's data by any reading, so it shares the
    // 400 status with a validation rejection — but not its message: the fault
    // is the size of the request, not the content of any field.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>', { status: 413 }));
    const res = await app.request('/api/v1/forms/testForm123/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice' }),
    });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toContain('too large');
    expect(json.error).toContain('smaller payload');
    expect(json.error).not.toContain('validation rules');
    expect(json.error).not.toContain('rejected the submission');
  });

  test('returns 502 naming the status when the form is gone (404)', async () => {
    // A deleted or unpublished form is not the caller's data; telling them to
    // check their values would send them after a fault that is not theirs.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>', { status: 404 }));
    const res = await app.request('/api/v1/forms/testForm123/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice' }),
    });
    expect(res.status).toBe(502);
    const json = await res.json() as { error: string };
    expect(json.error).toContain('404');
    expect(json.error).not.toContain('validation rules');
    expect(json.error).not.toContain('rejected the submission');
  });

  test('returns 502 naming the status when Google rate limits (429)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>', { status: 429 }));
    const res = await app.request('/api/v1/forms/testForm123/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice' }),
    });
    expect(res.status).toBe(502);
    const json = await res.json() as { error: string };
    expect(json.error).toContain('429');
    expect(json.error).not.toContain('validation rules');
  });

  test('returns 400 naming the field when a value is an object, without calling Google', async () => {
    // Locally detected bad value: never sent upstream, so it must read as the
    // client's fault and keep the message that names the offending field.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await app.request('/api/v1/forms/untypedFieldForm/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grid_answer: { 'Row 1': 'Option A' } }),
    });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toContain('grid_answer');
    expect(json.error).toContain('object value');
    expect(json.error).not.toContain('validation rules');
    expect(fetchSpy).not.toHaveBeenCalled();
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
