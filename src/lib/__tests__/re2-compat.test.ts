import { describe, test, expect } from 'vitest';
import { toJavaScriptRegexSource } from '../re2-compat.js';

const compile = (pattern: string): RegExp => {
  const source = toJavaScriptRegexSource(pattern);
  expect(source).not.toBeNull();
  return new RegExp(source as string);
};

describe('toJavaScriptRegexSource — verified-identical constructs pass through', () => {
  test.each([
    '^[A-Z]+$',
    '^(?:[a-z]+\\d)$',
    'a\\\\z',
    '\\d{2,4}(-|/)\\d{2}',
    '\\w+@\\w+\\.[a-z]{2,}',
    '(foo|bar)+',
    '\\x41\\t\\n',
    '[^0-9-]',
  ])('%s stays evaluable', (pattern) => {
    expect(toJavaScriptRegexSource(pattern)).not.toBeNull();
  });
});

describe('toJavaScriptRegexSource — exact translations', () => {
  test('dot matches \\r, U+2028, and a non-BMP code point, but not \\n', () => {
    const re = compile('^.$');
    expect(re.test('\r')).toBe(true);
    expect(re.test('\u2028')).toBe(true);
    expect(re.test('\u{1F600}')).toBe(true);
    expect(re.test('\n')).toBe(false);
  });

  test('dot inside a character class stays a literal dot', () => {
    const re = compile('^[.]$');
    expect(re.test('.')).toBe(true);
    expect(re.test('x')).toBe(false);
  });

  test('\\s and \\S use RE2 ASCII whitespace', () => {
    expect(compile('^\\s$').test('\u00A0')).toBe(false);
    expect(compile('^\\s$').test(' ')).toBe(true);
    expect(compile('^\\S$').test('\u00A0')).toBe(true);
  });

  test('\\s expands inside a character class', () => {
    const re = compile('^[\\s,]+$');
    expect(re.test(' ,\t')).toBe(true);
    expect(re.test('\u00A0')).toBe(false);
  });
});

describe('toJavaScriptRegexSource — everything else is rejected, not guessed', () => {
  test.each([
    '(?i)abc',
    '(?P<year>\\d{4})',
    '(?=x)',
    'foo\\z',
    '\\Ax',
    '\\Qa.b\\E',
    '\\p{L}+',
    '\\a',
    '\\x{41}',
    '\\101',
    '[[:alpha:]]',
    '[:alpha:]',
    '[\\S]',
    '[a-z',
    'trailing\\',
    '\u{1F600}',
  ])('%s returns null', (pattern) => {
    expect(toJavaScriptRegexSource(pattern)).toBeNull();
  });
});
