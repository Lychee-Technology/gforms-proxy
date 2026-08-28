import { describe, test, expect, vi, afterEach } from 'vitest';
import { submitToGoogleForms, SubmissionError } from '../submitter.js';

afterEach(() => { vi.restoreAllMocks(); });

const SUBMISSION_URL = 'https://docs.google.com/forms/d/e/test/formResponse';
const FIELD_MAP = {
  full_name: 'entry.111',
  email: 'entry.222',
  tags: 'entry.333',
};

describe('submitToGoogleForms — URL encoding', () => {
  test('encodes string fields as entry.XXXXXXX=value', async () => {
    let capturedBody: string | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = (init?.body as string) ?? null;
      return new Response('', { status: 200 });
    });

    await submitToGoogleForms(SUBMISSION_URL, FIELD_MAP, { full_name: 'Alice', email: 'alice@example.com' });

    expect(capturedBody).toContain('entry.111=Alice');
    expect(capturedBody).toContain('entry.222=alice%40example.com');
  });

  test('encodes array (checkbox) fields by repeating entry ID', async () => {
    let capturedBody: string | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = (init?.body as string) ?? null;
      return new Response('', { status: 200 });
    });

    await submitToGoogleForms(SUBMISSION_URL, FIELD_MAP, { tags: ['a', 'b'] });

    expect(capturedBody).toContain('entry.333=a');
    expect(capturedBody).toContain('entry.333=b');
  });

  test('omits absent optional fields', async () => {
    let capturedBody: string | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = (init?.body as string) ?? null;
      return new Response('', { status: 200 });
    });

    await submitToGoogleForms(SUBMISSION_URL, FIELD_MAP, { full_name: 'Bob' });

    expect(capturedBody).not.toContain('entry.222');
    expect(capturedBody).not.toContain('entry.333');
  });

  test('encodes number fields as string', async () => {
    let capturedBody: string | null = null;
    const fieldMap = { age: 'entry.444' };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = (init?.body as string) ?? null;
      return new Response('', { status: 200 });
    });

    await submitToGoogleForms(SUBMISSION_URL, fieldMap, { age: 25 });

    expect(capturedBody).toContain('entry.444=25');
  });
});

describe('submitToGoogleForms — object value guard', () => {
  test('throws SubmissionError on object-typed value without calling fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));

    await expect(
      submitToGoogleForms(SUBMISSION_URL, FIELD_MAP, {
        full_name: { 'Row 1': 'Option A' },
      }),
    ).rejects.toThrow(SubmissionError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('throws SubmissionError when an array value contains an object item', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));

    await expect(
      submitToGoogleForms(SUBMISSION_URL, FIELD_MAP, {
        tags: ['ok', { nested: true }],
      }),
    ).rejects.toThrow(SubmissionError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('error message names the offending field key', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));

    await expect(
      submitToGoogleForms(SUBMISSION_URL, FIELD_MAP, { email: { a: 1 } }),
    ).rejects.toThrow(/email/);
  });

  test("marks the error 'invalid-value' with no status, so the route answers 400", async () => {
    // Nothing was sent upstream, so there is no status to carry; the kind is
    // what tells the route this is the client's value, not Google's answer.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));

    await expect(
      submitToGoogleForms(SUBMISSION_URL, FIELD_MAP, { email: { a: 1 } }),
    ).rejects.toMatchObject({ kind: 'invalid-value', statusCode: undefined });
  });
});

describe('submitToGoogleForms — HTTP behavior', () => {
  test('POSTs to submissionUrl with correct Content-Type', async () => {
    let capturedUrl: string | null = null;
    let capturedHeaders: HeadersInit | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = url as string;
      capturedHeaders = init?.headers;
      return new Response('', { status: 200 });
    });

    await submitToGoogleForms(SUBMISSION_URL, FIELD_MAP, { full_name: 'Alice' });

    expect(capturedUrl).toBe(SUBMISSION_URL);
    const headers = new Headers(capturedHeaders as HeadersInit);
    expect(headers.get('content-type')).toContain('application/x-www-form-urlencoded');
  });

  test('throws SubmissionError on non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));

    await expect(
      submitToGoogleForms(SUBMISSION_URL, FIELD_MAP, { full_name: 'Alice' }),
    ).rejects.toThrow(SubmissionError);
  });

  test('carries the upstream status code so the route can tell 4xx from 5xx', async () => {
    // A 400 means Google rejected the submission against the form's own
    // validation rules; the route maps that to a 400, not a 502 (ADR 0006).
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>', { status: 400 }));

    await expect(
      submitToGoogleForms(SUBMISSION_URL, FIELD_MAP, { full_name: 'Alice' }),
    ).rejects.toMatchObject({ statusCode: 400, kind: 'upstream' });
  });

  test("marks a non-validation 4xx 'upstream' so the route keeps it off the 400 path", async () => {
    // A 404 is a deleted or unpublished form, not a bad value.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>', { status: 404 }));

    await expect(
      submitToGoogleForms(SUBMISSION_URL, FIELD_MAP, { full_name: 'Alice' }),
    ).rejects.toMatchObject({ statusCode: 404, kind: 'upstream' });
  });

  test('throws SubmissionError on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    await expect(
      submitToGoogleForms(SUBMISSION_URL, FIELD_MAP, { full_name: 'Alice' }),
    ).rejects.toThrow(SubmissionError);
  });

  test('leaves statusCode unset on a network error, so the route keeps 502', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    await expect(
      submitToGoogleForms(SUBMISSION_URL, FIELD_MAP, { full_name: 'Alice' }),
    ).rejects.toMatchObject({ statusCode: undefined, kind: 'upstream' });
  });
});
