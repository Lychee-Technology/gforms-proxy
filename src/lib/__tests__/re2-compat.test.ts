import { describe, test, expect } from 'vitest';
import { toJavaScriptRegexSource, JS_REGEX_FLAGS } from '../re2-compat.js';

const compile = (pattern: string): RegExp => {
  const source = toJavaScriptRegexSource(pattern);
  expect(source).not.toBeNull();
  return new RegExp(source as string, JS_REGEX_FLAGS);
};

describe('toJavaScriptRegexSource — verified-identical constructs pass through', () => {
  test.each([
    '^[A-Z]+$',
    '^(?:[a-z]+\\d)$',
    'a\\\\z',
    'a{2}',
    '^a+?$',
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

describe('toJavaScriptRegexSource \u2014 code-point semantics (RE2 matches code points, not units)', () => {
  test('a non-BMP literal is one atom and can be quantified', () => {
    const re = compile('^\u{1F600}+$');
    expect(re.test('\u{1F600}')).toBe(true);
    expect(re.test('\u{1F600}\u{1F600}')).toBe(true);
  });

  test('two dots require two code points: one emoji cannot satisfy both', () => {
    const re = compile('^..$');
    expect(re.test('\u{1F600}')).toBe(false);
    expect(re.test('\u{1F600}\u{1F600}')).toBe(true);
    expect(re.test('ab')).toBe(true);
  });

  test('a quantified dot counts code points', () => {
    const re = compile('^.{2}$');
    expect(re.test('\u{1F600}')).toBe(false);
    expect(re.test('\u{1F600}\u{1F600}')).toBe(true);
  });

  test('\\S\\S requires two code points', () => {
    const re = compile('^\\S\\S$');
    expect(re.test('\u{1F600}')).toBe(false);
    expect(re.test('\u{1F600}\u{1F600}')).toBe(true);
  });

  test('a negated character class matches a full code point atomically', () => {
    const re = compile('^[^x][^x]$');
    expect(re.test('\u{1F600}')).toBe(false);
    expect(re.test('\u{1F600}\u{1F600}')).toBe(true);
  });

  test('literal braces and brackets outside quantifiers stay enforced as literals', () => {
    expect(compile('^a{$').test('a{')).toBe(true);
    expect(compile('^a{,2}$').test('a{,2}')).toBe(true);
    expect(compile('^a]$').test('a]')).toBe(true);
    const quant = compile('^a{2,3}$');
    expect(quant.test('aa')).toBe(true);
    expect(quant.test('a{2,3}')).toBe(false);
  });

  test('escaped punctuation survives the stricter compile', () => {
    expect(compile('^\\-\\!$').test('-!')).toBe(true);
    expect(compile('^a\\\\z$').test('a\\z')).toBe(true);
  });
});

describe('toJavaScriptRegexSource — everything else is rejected, not guessed', () => {
  test.each([
    '^(?:(a+)+)$',
    '^(?:a+a+)$',
    '^(?:(a|aa)+)$',
    'a+',
    '\\d{2,4}(-|/)\\d{2}',
    '\\w+@\\w+\\.[a-z]{2,}',
    '(foo|bar)+',
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
    '\uD83D',
    '\uDE00',
  ])('%s returns null', (pattern) => {
    expect(toJavaScriptRegexSource(pattern)).toBeNull();
  });
});
