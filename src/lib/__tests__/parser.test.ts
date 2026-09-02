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

// Payload shapes mirror what python-gforms parses and what the two registered
// forms return live: a grid carries one tuple per row in field[4]; date and
// time carry their flags at tuple index 7 and 6 respectively.
const wrap = (fields: unknown[]) =>
  `<html><head><title>T - Google Forms</title></head><body><script>var FB_PUBLIC_LOAD_DATA_ = ${JSON.stringify(
    [null, [null, fields]],
  )};\n</script></body></html>`;

const GRID_FIELD = [
  null,
  'Rate each item',
  '',
  7,
  [
    [111, [['Good'], ['Bad']], 1, ['Speed'], null, null, null, null, null, null, null, [0]],
    [222, [['Good'], ['Bad']], 1, ['Price'], null, null, null, null, null, null, null, [0]],
  ],
];

describe('parseFormHtml — grid, date and time (#23)', () => {
  test('captures one entry ID per grid row with its label', () => {
    const { fields } = parseFormHtml(wrap([GRID_FIELD]), VALID_URL);
    expect(fields).toHaveLength(1);
    const grid = fields[0]!;
    expect(grid.typeLabel).toBe('multiple_choice_grid');
    expect(grid.entryId).toBe('entry.111');
    expect(grid.options).toEqual(['Good', 'Bad']);
    expect(grid.required).toBe(true);
    expect(grid.rows).toEqual([
      { label: 'Speed', entryId: 'entry.111' },
      { label: 'Price', entryId: 'entry.222' },
    ]);
  });

  test('labels a grid whose multichoice flag is set as checkbox_grid', () => {
    const field = structuredClone(GRID_FIELD) as any[];
    field[4][0][11] = [1];
    const { fields } = parseFormHtml(wrap([field]), VALID_URL);
    expect(fields[0]!.typeLabel).toBe('checkbox_grid');
    expect(fields[0]!.rows).toHaveLength(2);
  });

  test('falls back to a positional row label when the tuple carries none', () => {
    const field = structuredClone(GRID_FIELD) as any[];
    field[4][1][3] = null;
    const { fields } = parseFormHtml(wrap([field]), VALID_URL);
    expect(fields[0]!.rows?.[1]).toEqual({ label: 'Row 2', entryId: 'entry.222' });
  });

  test('does not attach rows to non-grid questions', () => {
    const { fields } = parseFormHtml(MINIMAL_HTML, VALID_URL);
    expect(fields[0]!.rows).toBeUndefined();
  });

  test.each([
    ['date with year and no time', [[333, null, 0, null, null, null, null, [0, 1]]], 'date'],
    ['date with no flag array', [[333, null, 0]], 'date'],
    ['date that includes a time', [[333, null, 0, null, null, null, null, [1, 1]]], 'date_time'],
    ['date without a year', [[333, null, 0, null, null, null, null, [0, 0]]], 'date_without_year'],
  ])('labels a %s', (_name, entries, expected) => {
    const { fields } = parseFormHtml(wrap([[null, 'When?', '', 9, entries]]), VALID_URL);
    expect(fields[0]!.typeLabel).toBe(expected);
    expect(fields[0]!.entryId).toBe('entry.333');
  });

  test.each([
    ['time', [[444, null, 0, null, null, null, [0]]], 'time'],
    ['time with no flag array', [[444, null, 0]], 'time'],
    ['duration', [[444, null, 0, null, null, null, [1]]], 'duration'],
  ])('labels a %s', (_name, entries, expected) => {
    const { fields } = parseFormHtml(wrap([[null, 'How long?', '', 10, entries]]), VALID_URL);
    expect(fields[0]!.typeLabel).toBe(expected);
  });

  test('rejects a grid row without an entry ID instead of dropping it', () => {
    const field = structuredClone(GRID_FIELD) as any[];
    field[4][1][0] = null;
    expect(() => parseFormHtml(wrap([field]), VALID_URL)).toThrow(FormParseError);
    expect(() => parseFormHtml(wrap([field]), VALID_URL)).toThrow(/Rate each item.*row 2/);
  });

  test('rejects a grid row whose entry ID is not a number or string', () => {
    const field = structuredClone(GRID_FIELD) as any[];
    field[4][1][0] = [222];
    expect(() => parseFormHtml(wrap([field]), VALID_URL)).toThrow(FormParseError);
  });

  test.each([
    ['date flags that are strings', 9, [[333, null, 0, null, null, null, null, ['0', '0']]], 'date'],
    ['date flags that are objects', 9, [[333, null, 0, null, null, null, null, [{}, {}]]], 'date'],
    ['a time flag that is a string', 10, [[444, null, 0, null, null, null, ['1']]], 'time'],
    ['a grid flag that is a string', 7, [[111, [['Good']], 0, ['Speed'], null, null, null, null, null, null, null, ['1']]], 'multiple_choice_grid'],
  ])('falls back to the default variant for %s', (_name, code, entries, expected) => {
    const { fields } = parseFormHtml(wrap([[null, 'Q', '', code, entries]]), VALID_URL);
    expect(fields[0]!.typeLabel).toBe(expected);
  });

  // Google emits flags as exactly 0 or 1; any other number is malformed and
  // must not switch a variant on (or off).
  test.each([
    ['a grid flag of 2', 7, [[111, [['Good']], 0, ['Speed'], null, null, null, null, null, null, null, [2]]], 'multiple_choice_grid'],
    ['a date time flag of -1', 9, [[333, null, 0, null, null, null, null, [-1, 1]]], 'date'],
    ['a date year flag of 2', 9, [[333, null, 0, null, null, null, null, [0, 2]]], 'date'],
    ['a duration flag of 2', 10, [[444, null, 0, null, null, null, [2]]], 'time'],
  ])('falls back to the default variant for %s', (_name, code, entries, expected) => {
    const { fields } = parseFormHtml(wrap([[null, 'Q', '', code, entries]]), VALID_URL);
    expect(fields[0]!.typeLabel).toBe(expected);
  });

  // An entry tuple that is present but carries no usable ID is a malformed
  // question, not an entry-less block: publishing it would map the field to a
  // parameter Google does not have.
  test.each([
    ['a date with a null entry ID', 9, [[null, null, 0, null, null, null, null, [0, 1]]]],
    ['a time with an object entry ID', 10, [[{ id: 444 }, null, 0]]],
    ['a short answer with an empty-string entry ID', 0, [['', null, 0]]],
  ])('rejects %s instead of publishing it', (_name, code, entries) => {
    expect(() => parseFormHtml(wrap([[null, 'When?', '', code, entries]]), VALID_URL)).toThrow(
      FormParseError,
    );
    expect(() => parseFormHtml(wrap([[null, 'When?', '', code, entries]]), VALID_URL)).toThrow(
      /When\?.*entry ID/,
    );
  });

  test('accepts a string entry ID', () => {
    const { fields } = parseFormHtml(wrap([[null, 'Q', '', 0, [['123', null, 0]]]]), VALID_URL);
    expect(fields[0]!.entryId).toBe('entry.123');
  });

  test('type code 6 is a title block, not a grid', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fields } = parseFormHtml(
      wrap([[null, 'Section', 'intro', 6, null], [null, 'Name', '', 0, [[555, null, 0]]]]),
      VALID_URL,
    );
    expect(fields.map((f) => f.label)).toEqual(['Name']);
  });
});
