import { describe, test, expect, vi, afterEach } from 'vitest';
import {
  extractFormTitle,
  extractFormId,
  validateFormUrl,
  parseFormHtml,
  fetchFormHtml,
  FormParseError,
  FormFetchError,
} from '../parser.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const MINIMAL_PAYLOAD = JSON.stringify([
  null,
  [
    null,
    [
      [null, 'What is your name?', 'Your full name', 0, [[123456, null, 1]]],
      [null, 'Choose one', '', 2, [[789012, [['Option A'], ['Option B']], 0]]],
    ],
  ],
]);

const MINIMAL_HTML = `<html><head><title>Test Form - Google Forms</title></head>
<body><script>var FB_PUBLIC_LOAD_DATA_ = ${MINIMAL_PAYLOAD};\n</script></body></html>`;

const VALID_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSabc123/viewform';

describe('extractFormTitle', () => {
  test('strips Google Forms suffix', () => {
    expect(extractFormTitle('<title>My Survey - Google Forms</title>')).toBe('My Survey');
  });
  test('handles mixed case suffix', () => {
    expect(extractFormTitle('<title>Test - google forms</title>')).toBe('Test');
  });
  test('returns fallback when no title tag', () => {
    expect(extractFormTitle('<html></html>')).toBe('Google Form');
  });
});

describe('extractFormId', () => {
  test('extracts ID from standard viewform URL', () => {
    expect(extractFormId('https://docs.google.com/forms/d/e/1FAIpQLSabc123/viewform')).toBe('1FAIpQLSabc123');
  });
  test('returns empty string for unrecognized URL', () => {
    expect(extractFormId('https://example.com')).toBe('');
  });
});

describe('validateFormUrl', () => {
  test('accepts valid Google Forms viewform URL', () => {
    expect(() => validateFormUrl(VALID_URL)).not.toThrow();
  });
  test('rejects non-Google URL', () => {
    expect(() => validateFormUrl('https://example.com/form')).toThrow(FormParseError);
  });
  test('rejects Google Forms edit URL (not viewform)', () => {
    expect(() =>
      validateFormUrl('https://docs.google.com/forms/d/1FAIpQLSabc123/edit'),
    ).toThrow(FormParseError);
  });
  test('accepts viewform URL with query string', () => {
    expect(() => validateFormUrl(`${VALID_URL}?usp=sf_link`)).not.toThrow();
  });
  test('accepts viewform URL with fragment', () => {
    expect(() => validateFormUrl(`${VALID_URL}#responses`)).not.toThrow();
  });
  test('rejects path traversal escaping the forms path', () => {
    expect(() =>
      validateFormUrl(`${VALID_URL}/../../../../document/d/SECRET/edit`),
    ).toThrow(FormParseError);
  });
  test('rejects traversal that retargets a different form', () => {
    expect(() =>
      validateFormUrl(`${VALID_URL}/../../../e/1FAIpQLSother456/viewform`),
    ).toThrow(FormParseError);
  });
  test('rejects extra path segments after viewform', () => {
    expect(() => validateFormUrl(`${VALID_URL}/formResponse`)).toThrow(FormParseError);
  });
  test('rejects a trailing slash after viewform', () => {
    expect(() => validateFormUrl(`${VALID_URL}/`)).toThrow(FormParseError);
  });
  test('rejects a backslash-escaped path segment after viewform', () => {
    expect(() => validateFormUrl(`${VALID_URL}\\..\\..\\document`)).toThrow(FormParseError);
  });
});

describe('parseFormHtml', () => {
  test('parses field labels and entry IDs', () => {
    const result = parseFormHtml(MINIMAL_HTML, VALID_URL);
    expect(result.formTitle).toBe('Test Form');
    expect(result.formId).toBe('1FAIpQLSabc123');
    expect(result.fields).toHaveLength(2);
    expect(result.fields[0]?.label).toBe('What is your name?');
    expect(result.fields[0]?.entryId).toBe('entry.123456');
    expect(result.fields[0]?.required).toBe(true);
    expect(result.fields[0]?.typeLabel).toBe('short_answer');
  });
  test('parses multiple_choice options', () => {
    const result = parseFormHtml(MINIMAL_HTML, VALID_URL);
    expect(result.fields[1]?.options).toEqual(['Option A', 'Option B']);
    expect(result.fields[1]?.typeLabel).toBe('multiple_choice');
  });
  test('throws FormParseError when FB_PUBLIC_LOAD_DATA_ missing', () => {
    expect(() => parseFormHtml('<html><body></body></html>', VALID_URL)).toThrow(FormParseError);
  });
  test('throws FormParseError when FB_PUBLIC_LOAD_DATA_ is malformed JSON', () => {
    const badHtml = `<html><script>var FB_PUBLIC_LOAD_DATA_ = {bad json};\n</script></html>`;
    expect(() => parseFormHtml(badHtml, VALID_URL)).toThrow(FormParseError);
  });
  test('throws FormParseError when form has no fields', () => {
    const emptyPayload = JSON.stringify([null, [null, []]]);
    const html = `<html><script>var FB_PUBLIC_LOAD_DATA_ = ${emptyPayload};\n</script></html>`;
    expect(() => parseFormHtml(html, VALID_URL)).toThrow(FormParseError);
  });
});

// fetchFormHtml runs in the CLI generator, not the Worker (ADR 0007), so the
// timeout bounds a build-time run rather than a request. It is still the same
// contract: an upstream that never answers must not hang forever.
describe('fetchFormHtml — outbound timeout (#10)', () => {
  const timeoutError = () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    return err;
  };

  test('attaches a live AbortSignal to the request', async () => {
    let capturedSignal: unknown = undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedSignal = init?.signal;
      return new Response(MINIMAL_HTML, { status: 200 });
    });

    await fetchFormHtml(VALID_URL);

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect((capturedSignal as AbortSignal).aborted).toBe(false);
  });

  test('surfaces a timeout as FormFetchError', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(timeoutError());

    const err = await fetchFormHtml(VALID_URL).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FormFetchError);
    expect((err as Error).message).toMatch(/timed out/i);
  });

  // The signal stays live through the body read, so an abort can land after
  // the response headers arrive. That must not escape as a raw DOMException.
  test('surfaces a failure during the body read as FormFetchError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.reject(timeoutError()),
    } as unknown as Response);

    const err = await fetchFormHtml(VALID_URL).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FormFetchError);
  });

  test('still reports a plain network failure as a network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

    const err = await fetchFormHtml(VALID_URL).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FormFetchError);
    expect((err as Error).message).toMatch(/network error/i);
  });
});
