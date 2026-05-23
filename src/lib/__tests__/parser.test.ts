import { describe, test, expect } from 'vitest';
import {
  extractFormTitle,
  extractFormId,
  validateFormUrl,
  parseFormHtml,
  FormParseError,
  FormFetchError,
} from '../parser.js';

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
