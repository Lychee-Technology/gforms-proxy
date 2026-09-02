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

// ADVERSARIAL FIXTURE — a plain string mapping whose property declares no
// type, so the validator lets an object value through to the submitter. The
// generator always declares a type, and an object only belongs under a grid
// mapping (#23), so this drift is the only way to exercise the submitter's
// own scalar guard through the route. Never copy this shape.
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

// What the generator emits for a form with one grid, one date and one time
// question: named rows, structured fieldMap entries (#23).
const COMPOUND_DEFINITION: FormDefinition = {
  formId: 'compoundForm',
  submissionUrl: 'https://docs.google.com/forms/d/e/compoundForm/formResponse',
  schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['ratings'],
    properties: {
      ratings: {
        type: 'object',
        properties: {
          speed: { type: 'string', enum: ['Good', 'Bad'] },
          price: { type: 'string', enum: ['Good', 'Bad'] },
        },
        required: ['speed', 'price'],
        additionalProperties: false,
      },
      when: { type: 'string', format: 'date' },
      at: { type: 'string', format: 'time' },
    },
  },
  fieldMap: {
    ratings: { kind: 'grid', rows: { speed: 'entry.701', price: 'entry.702' } },
    when: { kind: 'date', entryId: 'entry.500' },
    at: { kind: 'time', entryId: 'entry.600' },
  },
};

vi.mock('../../forms/registry.js', () => ({
  default: new Map([
    ['testForm123', MOCK_DEFINITION],
    ['turnstileForm', MOCK_TURNSTILE_DEFINITION],
    ['driftedTurnstileForm', DRIFTED_TURNSTILE_DEFINITION],
    ['untypedFieldForm', UNTYPED_FIELD_DEFINITION],
    ['compoundForm', COMPOUND_DEFINITION],
  ]),
}));

// Import app AFTER mocking the registry
const { default: app } = await import('../../index.js');

afterEach(() => { vi.restoreAllMocks(); });

// A bare vi.spyOn(globalThis, 'fetch') calls through, so a test asserting "no
// outbound request" would contact docs.google.com for real if live extraction
// were ever reintroduced — slow, flaky, and traffic nobody asked for. Failing
// the call closed keeps the regression local to the test run.
function noOutboundFetch() {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('unexpected outbound fetch'));
}

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

describe('GET /api/v1/forms/:formId/schema', () => {
  test('returns the bundled schema for a registered form', async () => {
    const res = await app.request('/api/v1/forms/testForm123/schema');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(MOCK_DEFINITION.schema);
  });

  test('returns 404 for an unregistered formId', async () => {
    const res = await app.request('/api/v1/forms/unknown/schema');
    expect(res.status).toBe(404);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('Form not found');
  });

  // A Turnstile-protected form's schema describes the body POSTed to this
  // proxy, not the Google Form, so turnstile_token belongs in what a client
  // reads back here — otherwise it would build a submission the validator
  // rejects.
  test('keeps turnstile_token in a Turnstile-protected form\'s schema', async () => {
    const res = await app.request('/api/v1/forms/turnstileForm/schema');
    expect(res.status).toBe(200);
    const schema = await res.json() as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.properties).toHaveProperty('turnstile_token');
    expect(schema.required).toContain('turnstile_token');
  });

  // The point of this endpoint (issue #9): a registered form's schema is
  // already bundled into the Worker, so serving it must cost Google nothing.
  test('makes no outbound request', async () => {
    const fetchSpy = noOutboundFetch();
    const res = await app.request('/api/v1/forms/testForm123/schema');
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('removed routes', () => {
  // The Worker no longer performs live schema extraction (ADR 0007). These
  // assertions keep the route from being reintroduced by accident, and pin the
  // JSON 404 shape — Hono's default 404 is plain text, which would be the only
  // non-JSON response this API emits.
  test.each([
    ['GET', '/schema?url=https://docs.google.com/forms/d/e/abc/viewform'],
    ['GET', '/'],
  ])('%s %s returns a JSON 404', async (method, path) => {
    const res = await app.request(path, { method });
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const json = await res.json() as { error: string };
    expect(json.error).toBe('Not found');
  });

  test('POST /schema returns a JSON 404', async () => {
    const res = await app.request('/schema', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://docs.google.com/forms/d/e/abc/viewform' }),
    });
    expect(res.status).toBe(404);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('Not found');
  });

  // CORS preflight is answered by the cors() middleware before routing, so it
  // is 204 for every path, matched or not. That is deliberate: a preflight
  // negotiates transport, not resource existence, and making it route-aware
  // would tell any origin whether a formId is registered. The real request
  // that follows still gets the JSON 404.
  test.each([
    '/schema',
    '/',
    '/api/v1/forms/unknown/schema',
  ])('OPTIONS %s is answered by CORS with 204, not the JSON 404', async (path) => {
    const res = await app.request(path, {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'GET' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  test('neither /schema route reaches Google', async () => {
    const fetchSpy = noOutboundFetch();
    await app.request('/schema?url=https://docs.google.com/forms/d/e/abc/viewform');
    await app.request('/schema', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://docs.google.com/forms/d/e/abc/viewform' }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// The acceptance criterion for #10 is observable only at the route: a hanging
// upstream must come back as the endpoint's own 502/503, never an unhandled
// 500. Both modules map an abort onto their existing error class, so these
// assert the mapping end to end rather than trusting the unit tests alone.
describe('outbound fetch timeouts surface as 502/503 (#10)', () => {
  const timeoutError = () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    return err;
  };

  test('a timing-out submission to Google answers 502', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(timeoutError());

    const res = await app.request('/api/v1/forms/testForm123/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice' }),
    });

    expect(res.status).toBe(502);
  });

  test('a timing-out Turnstile siteverify answers 503', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(timeoutError());
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await app.request(
      '/api/v1/forms/turnstileForm/responses',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Alice', turnstile_token: 'tok' }),
      },
      { TURNSTILE_SECRET_KEY: 'test-secret' },
    );

    expect(res.status).toBe(503);
  });
});

// A free Cloudflare Worker gets 10 ms of CPU per request, and every scan the
// submission route runs is linear in the body a caller chose the size of
// (#29). The cap is the bound; these assert it holds on both of Hono's code
// paths and that it fires before anything expensive runs.
describe('request body size limit on the submission endpoint (#29)', () => {
  const LIMIT = 64 * 1024;

  // A single `name` string is the cheapest way to cross the limit without
  // tripping the validator first: MOCK_DEFINITION constrains it with
  // minLength: 1 and nothing else, so length alone decides the outcome.
  const bodyOfSize = (bytes: number) => {
    const envelope = JSON.stringify({ name: '' }).length;
    return JSON.stringify({ name: 'x'.repeat(bytes - envelope) });
  };

  test('a body over the limit is refused with a JSON 413', async () => {
    const fetchSpy = noOutboundFetch();

    const body = bodyOfSize(LIMIT + 1);
    const res = await app.request('/api/v1/forms/testForm123/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    expect(res.status).toBe(413);
    // Hono's default over-limit response is text/plain. Every error this API
    // emits is JSON (ADR 0007), so the custom onError is load-bearing.
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const json = await res.json() as { error: string };
    expect(json.error).toBe('Request body too large');
    // The point of the cap is that the work never starts.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('a body just under the limit is still accepted', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));

    const body = bodyOfSize(LIMIT);
    expect(body.length).toBe(LIMIT);

    const res = await app.request('/api/v1/forms/testForm123/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    expect(res.status).toBe(200);
  });

  // Without content-length Hono cannot short-circuit on the header: it reads
  // the stream and counts bytes, then rebuilds the Request for the handler.
  // That is a different branch entirely, so the header path passing says
  // nothing about it.
  test('an oversized streamed body with no content-length is refused too', async () => {
    const fetchSpy = noOutboundFetch();

    const chunk = new TextEncoder().encode('x'.repeat(8 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= LIMIT + 8 * 1024) {
          controller.close();
          return;
        }
        sent += chunk.length;
        controller.enqueue(chunk);
      },
    });

    const res = await app.request('/api/v1/forms/testForm123/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stream,
      duplex: 'half',
    } as RequestInit);

    expect(res.status).toBe(413);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('Request body too large');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // The other half of the streaming branch, and the riskier half: when a
  // streamed body comes in under the limit Hono rebuilds the Request around
  // the bytes it buffered, so the handler reads a body that has already been
  // consumed once. If that rebuild ever broke, every chunked submission would
  // fail — and the oversized case above would not notice, because it returns
  // before reaching it.
  test('an under-limit streamed body with no content-length still reaches Google', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }));

    const payload = new TextEncoder().encode(JSON.stringify({ name: 'Alice' }));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });

    const res = await app.request('/api/v1/forms/testForm123/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stream,
      duplex: 'half',
    } as RequestInit);

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  // The limit is route middleware, so it runs before the handler looks the
  // form up. An oversized body aimed at an unregistered ID gets 413, not the
  // usual 404. That discloses nothing — the 413 is identical either way —
  // and pinning it here keeps it a decision rather than a surprise.
  test('an oversized body to an unregistered formId is refused before the 404', async () => {
    const res = await app.request('/api/v1/forms/unknown/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyOfSize(LIMIT + 1),
    });

    expect(res.status).toBe(413);
  });

  // The schema route carries no body, so the cap does not belong on it.
  test('the schema route is unaffected', async () => {
    const res = await app.request('/api/v1/forms/testForm123/schema');
    expect(res.status).toBe(200);
  });
});

describe('POST /api/v1/forms/:formId/responses — grid, date and time (#23)', () => {
  test('submits a grid, a date and a time as their multi-parameter encodings', async () => {
    let capturedBody: string | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = (init?.body as string) ?? null;
      return new Response('', { status: 200 });
    });

    const res = await app.request('/api/v1/forms/compoundForm/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ratings: { speed: 'Good', price: 'Bad' }, when: '2026-02-28', at: '23:59' }),
    });

    expect(res.status).toBe(200);
    expect(capturedBody).toBe(
      'entry.701=Good&entry.702=Bad&entry.500_year=2026&entry.500_month=2&entry.500_day=28&entry.600_hour=23&entry.600_minute=59',
    );
  });

  test('answers 400 naming the row for an unknown grid row', async () => {
    const fetchSpy = noOutboundFetch();
    const res = await app.request('/api/v1/forms/compoundForm/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ratings: { speed: 'Good', price: 'Bad', extra: 'Good' } }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      details: [{ field: 'ratings.extra', message: 'additional property not allowed' }],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('answers 400 naming the field for a malformed date', async () => {
    noOutboundFetch();
    const res = await app.request('/api/v1/forms/compoundForm/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ratings: { speed: 'Good', price: 'Bad' }, when: '2026-02-30' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ details: [{ field: 'when', message: 'must match format: date' }] });
  });
});
