import { describe, test, expect } from 'vitest';
import { parse } from '../re2/parser.js';
import { compile } from '../re2/program.js';
import { matches } from '../re2/match.js';

const test_ = (pattern: string, input: string): boolean => {
  const ast = parse(pattern);
  expect(ast).not.toBeNull();
  const program = compile(ast as NonNullable<typeof ast>);
  expect(program).not.toBeNull();
  return matches(program as NonNullable<typeof program>, input);
};

describe('matches — search semantics', () => {
  test('an unanchored pattern searches, like RegExp.test', () => {
    expect(test_('b', 'abc')).toBe(true);
    expect(test_('b', 'ac')).toBe(false);
  });

  test('anchors pin the pattern to the whole text', () => {
    expect(test_('^abc$', 'abc')).toBe(true);
    expect(test_('^abc$', 'xabc')).toBe(false);
    expect(test_('^abc$', 'abcx')).toBe(false);
  });

  test('$ does not match before a trailing newline', () => {
    expect(test_('^a$', 'a\n')).toBe(false);
  });

  test('an empty pattern matches anything', () => {
    expect(test_('', '')).toBe(true);
    expect(test_('', 'anything')).toBe(true);
  });
});

describe('matches — constructs', () => {
  test('alternation', () => {
    expect(test_('^(yes|no)$', 'yes')).toBe(true);
    expect(test_('^(yes|no)$', 'no')).toBe(true);
    expect(test_('^(yes|no)$', 'maybe')).toBe(false);
  });

  test('multiple counted repetitions', () => {
    expect(test_('^\\d{3}-\\d{4}$', '555-1234')).toBe(true);
    expect(test_('^\\d{3}-\\d{4}$', '55-1234')).toBe(false);
  });

  test('multiple unbounded repetitions', () => {
    expect(test_('[a-z]+@[a-z]+\\.[a-z]+', 'someone@example.com')).toBe(true);
    expect(test_('[a-z]+@[a-z]+\\.[a-z]+', 'nope')).toBe(false);
  });

  test('a quantified group', () => {
    expect(test_('^(?:ab)+$', 'ababab')).toBe(true);
    expect(test_('^(?:ab)+$', 'aba')).toBe(false);
  });

  test('word boundaries use ASCII word characters', () => {
    expect(test_('\\bcat\\b', 'a cat sat')).toBe(true);
    expect(test_('\\bcat\\b', 'concatenate')).toBe(false);
    expect(test_('\\Bcat\\B', 'concatenate')).toBe(true);
  });

  test('RE2 whitespace excludes \\v and non-breaking space', () => {
    expect(test_('^\\s$', ' ')).toBe(true);
    expect(test_('^\\s$', '\t')).toBe(true);
    expect(test_('^\\s$', '\v')).toBe(false);
    expect(test_('^\\s$', ' ')).toBe(false);
    expect(test_('^\\S$', ' ')).toBe(true);
  });

  test('dot matches \\r and U+2028 but not \\n', () => {
    expect(test_('^.$', '\r')).toBe(true);
    expect(test_('^.$', ' ')).toBe(true);
    expect(test_('^.$', '\n')).toBe(false);
  });

  test('matching counts code points, not UTF-16 units', () => {
    expect(test_('^..$', '\u{1F600}')).toBe(false);
    expect(test_('^..$', '\u{1F600}\u{1F600}')).toBe(true);
    expect(test_('^\u{1F600}+$', '\u{1F600}\u{1F600}')).toBe(true);
  });

  test('a nullable repetition body terminates', () => {
    expect(test_('^(?:a?)*$', 'aaa')).toBe(true);
    expect(test_('^(?:a?)*$', 'b')).toBe(false);
  });

  test('a{0} matches the empty string', () => {
    expect(test_('^a{0}$', '')).toBe(true);
    expect(test_('^a{0}$', 'a')).toBe(false);
  });
});

describe('matches — no catastrophic backtracking', () => {
  test('a nested quantifier resolves in milliseconds', () => {
    const input = 'a'.repeat(40) + 'b';
    const started = Date.now();
    expect(test_('^(?:(a+)+)$', input)).toBe(false);
    expect(Date.now() - started).toBeLessThan(200);
  });

  test('concatenated ambiguous alternations resolve in milliseconds', () => {
    const pattern = '^' + '(?:a|aa)'.repeat(30) + 'b$';
    const started = Date.now();
    expect(test_(pattern, 'a'.repeat(40))).toBe(false);
    expect(Date.now() - started).toBeLessThan(200);
  });
});
