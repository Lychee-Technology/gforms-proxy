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

  test('throws SubmissionError on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    await expect(
      submitToGoogleForms(SUBMISSION_URL, FIELD_MAP, { full_name: 'Alice' }),
    ).rejects.toThrow(SubmissionError);
  });
});
