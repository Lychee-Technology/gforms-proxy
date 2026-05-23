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

vi.mock('../../forms/registry.js', () => ({
  default: new Map([['testForm123', MOCK_DEFINITION]]),
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
