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

const COMPOUND_MAP = {
  when: { kind: 'date' as const, entryId: 'entry.500' },
  at: { kind: 'time' as const, entryId: 'entry.600' },
  ratings: { kind: 'grid' as const, rows: { speed: 'entry.701', price: 'entry.702' } },
};

const captureBody = () => {
  let body: string | null = null;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    body = (init?.body as string) ?? null;
    return new Response('', { status: 200 });
  });
  return () => body;
};

describe('submitToGoogleForms — compound encodings (#23)', () => {
  test('splits a date into year, month and day parameters without leading zeros', async () => {
    const body = captureBody();
    await submitToGoogleForms(SUBMISSION_URL, COMPOUND_MAP, { when: '2026-01-05' });
    expect(body()).toBe('entry.500_year=2026&entry.500_month=1&entry.500_day=5');
  });

  test('splits a time into hour and minute parameters', async () => {
    const body = captureBody();
    await submitToGoogleForms(SUBMISSION_URL, COMPOUND_MAP, { at: '09:07' });
    expect(body()).toBe('entry.600_hour=9&entry.600_minute=7');
  });

  test('sends one parameter per grid row using that row entry ID', async () => {
    const body = captureBody();
    await submitToGoogleForms(SUBMISSION_URL, COMPOUND_MAP, {
      ratings: { speed: 'Good', price: 'Bad' },
    });
    expect(body()).toBe('entry.701=Good&entry.702=Bad');
  });

  test('repeats a row entry ID for each column of a checkbox-grid row', async () => {
    const body = captureBody();
    await submitToGoogleForms(SUBMISSION_URL, COMPOUND_MAP, {
      ratings: { speed: ['Good', 'Fast'] },
    });
    expect(body()).toBe('entry.701=Good&entry.701=Fast');
  });

  test('omits rows the caller left out and ignores rows the map does not know', async () => {
    const body = captureBody();
    await submitToGoogleForms(SUBMISSION_URL, COMPOUND_MAP, {
      ratings: { price: 'Bad', unknown: 'x' },
    });
    expect(body()).toBe('entry.702=Bad');
  });

  test('still encodes plain string mappings alongside compound ones', async () => {
    const body = captureBody();
    await submitToGoogleForms(
      SUBMISSION_URL,
      { ...FIELD_MAP, ...COMPOUND_MAP },
      { full_name: 'Alice', when: '2026-12-31' },
    );
    expect(body()).toBe('entry.111=Alice&entry.500_year=2026&entry.500_month=12&entry.500_day=31');
  });
});

describe('submitToGoogleForms — prototype-named keys', () => {
  // `{}` has no own "constructor", but `{}.constructor` is Object. Reading a
  // key without an ownership check would send that function's source.
  test('omits a grid row named like an Object.prototype member when the caller left it out', async () => {
    const body = captureBody();
    await submitToGoogleForms(
      SUBMISSION_URL,
      { ratings: { kind: 'grid', rows: { constructor: 'entry.1', speed: 'entry.2' } } },
      { ratings: {} },
    );
    expect(body()).toBe('');
  });

  test('omits a top-level field named like an Object.prototype member when absent', async () => {
    const body = captureBody();
    await submitToGoogleForms(SUBMISSION_URL, { constructor: 'entry.9', name: 'entry.1' }, { name: 'A' });
    expect(body()).toBe('entry.1=A');
  });

  test('still sends such a key when it is an own property', async () => {
    const body = captureBody();
    await submitToGoogleForms(
      SUBMISSION_URL,
      { ratings: { kind: 'grid', rows: { constructor: 'entry.1' } } },
      { ratings: JSON.parse('{"constructor":"Good"}') },
    );
    expect(body()).toBe('entry.1=Good');
  });
});

describe('submitToGoogleForms — value shape guard', () => {
  const rejects = async (
    fieldMap: Record<string, any>,
    data: Record<string, unknown>,
    re: RegExp,
  ) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));
    const err = await submitToGoogleForms(SUBMISSION_URL, fieldMap, data).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubmissionError);
    expect((err as SubmissionError).message).toMatch(re);
    // Nothing was sent upstream, so there is no status to carry; the kind is
    // what tells the route this is the client's value, not Google's answer.
    expect(err).toMatchObject({ kind: 'invalid-value', statusCode: undefined });
    expect(fetchSpy).not.toHaveBeenCalled();
  };

  test('rejects an object where a plain mapping expects a scalar', () =>
    rejects(FIELD_MAP, { full_name: { 'Row 1': 'Option A' } }, /full_name/));

  test('rejects an object item inside an array value', () =>
    rejects(FIELD_MAP, { tags: ['ok', { nested: true }] }, /tags/));

  test('rejects a date value that is not YYYY-MM-DD', () =>
    rejects(COMPOUND_MAP, { when: '05/01/2026' }, /when.*YYYY-MM-DD/));

  test('rejects a non-string date value', () =>
    rejects(COMPOUND_MAP, { when: 20260105 }, /when/));

  test('rejects a time value that is not HH:MM', () =>
    rejects(COMPOUND_MAP, { at: '9:07' }, /at.*HH:MM/));

  test('rejects a non-object grid value', () =>
    rejects(COMPOUND_MAP, { ratings: 'Good' }, /ratings/));

  test('rejects an array as a grid value', () =>
    rejects(COMPOUND_MAP, { ratings: ['Good'] }, /ratings/));

  test('rejects an object inside a grid row and names the row', () =>
    rejects(COMPOUND_MAP, { ratings: { speed: { deep: 1 } } }, /ratings\.speed/));
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

describe('submitToGoogleForms — outbound timeout (#10)', () => {
  test('attaches a live AbortSignal to the request', async () => {
    let capturedSignal: unknown = undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedSignal = init?.signal;
      return new Response('', { status: 200 });
    });

    await submitToGoogleForms(SUBMISSION_URL, FIELD_MAP, { full_name: 'Alice' });

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect((capturedSignal as AbortSignal).aborted).toBe(false);
  });

  test('surfaces a timeout as an upstream SubmissionError, not an unhandled throw', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(timeout);

    const err = await submitToGoogleForms(SUBMISSION_URL, FIELD_MAP, { full_name: 'Alice' }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(SubmissionError);
    expect((err as SubmissionError).message).toMatch(/timed out/i);
    // These two are what pin the route's answer to 502 rather than 400.
    expect((err as SubmissionError).kind).toBe('upstream');
    expect((err as SubmissionError).statusCode).toBeUndefined();
  });

  test('still reports a plain network failure as a network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

    const err = await submitToGoogleForms(SUBMISSION_URL, FIELD_MAP, { full_name: 'Alice' }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(SubmissionError);
    expect((err as SubmissionError).message).toMatch(/network error/i);
  });
});
