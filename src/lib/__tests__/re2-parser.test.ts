import { describe, test, expect } from 'vitest';
import { parse, RE2_MAX_REPEAT } from '../re2/parser.js';

describe('parse — structure', () => {
  test('a literal becomes a char node', () => {
    expect(parse('a')).toEqual({ kind: 'char', codePoint: 0x61 });
  });

  test('a non-BMP literal is one code point, not a surrogate pair', () => {
    expect(parse('\u{1F600}')).toEqual({ kind: 'char', codePoint: 0x1f600 });
  });

  test('concatenation nests left to right', () => {
    expect(parse('ab')).toEqual({
      kind: 'concat',
      nodes: [
        { kind: 'char', codePoint: 0x61 },
        { kind: 'char', codePoint: 0x62 },
      ],
    });
  });

  test('alternation is a top-level alt node', () => {
    expect(parse('a|b')).toEqual({
      kind: 'alt',
      nodes: [
        { kind: 'char', codePoint: 0x61 },
        { kind: 'char', codePoint: 0x62 },
      ],
    });
  });

  test('an empty alternation branch is an empty node', () => {
    expect(parse('a|')).toEqual({
      kind: 'alt',
      nodes: [{ kind: 'char', codePoint: 0x61 }, { kind: 'empty' }],
    });
  });

  test('capturing and non-capturing groups parse identically', () => {
    expect(parse('(ab)')).toEqual(parse('(?:ab)'));
  });

  test('anchors and word boundaries become assertions', () => {
    expect(parse('^')).toEqual({ kind: 'assert', assertion: 'start' });
    expect(parse('$')).toEqual({ kind: 'assert', assertion: 'end' });
    expect(parse('\\b')).toEqual({ kind: 'assert', assertion: 'word' });
    expect(parse('\\B')).toEqual({ kind: 'assert', assertion: 'notWord' });
  });
});

describe('parse — RE2 semantics that differ from JavaScript', () => {
  test('dot is every code point except newline', () => {
    expect(parse('.')).toEqual({
      kind: 'class',
      negated: true,
      ranges: [{ lo: 0x0a, hi: 0x0a }],
    });
  });

  test('\\s is RE2 ASCII whitespace and excludes \\v', () => {
    expect(parse('\\s')).toEqual({
      kind: 'class',
      negated: false,
      ranges: [
        { lo: 0x09, hi: 0x0a },
        { lo: 0x0c, hi: 0x0d },
        { lo: 0x20, hi: 0x20 },
      ],
    });
  });

  test('\\S is the same set, negated', () => {
    const space = parse('\\s') as { ranges: unknown };
    expect(parse('\\S')).toEqual({
      kind: 'class',
      negated: true,
      ranges: space.ranges,
    });
  });

  test('\\d and \\w are ASCII', () => {
    expect(parse('\\d')).toEqual({
      kind: 'class',
      negated: false,
      ranges: [{ lo: 0x30, hi: 0x39 }],
    });
    expect(parse('\\w')).toEqual({
      kind: 'class',
      negated: false,
      ranges: [
        { lo: 0x30, hi: 0x39 },
        { lo: 0x41, hi: 0x5a },
        { lo: 0x5f, hi: 0x5f },
        { lo: 0x61, hi: 0x7a },
      ],
    });
  });

  test('control and hex escapes resolve to code points', () => {
    expect(parse('\\t')).toEqual({ kind: 'char', codePoint: 0x09 });
    expect(parse('\\n')).toEqual({ kind: 'char', codePoint: 0x0a });
    expect(parse('\\v')).toEqual({ kind: 'char', codePoint: 0x0b });
    expect(parse('\\x41')).toEqual({ kind: 'char', codePoint: 0x41 });
  });

  test('escaped ASCII punctuation is that punctuation', () => {
    expect(parse('\\-')).toEqual({ kind: 'char', codePoint: 0x2d });
    expect(parse('\\|')).toEqual({ kind: 'char', codePoint: 0x7c });
    expect(parse('\\\\')).toEqual({ kind: 'char', codePoint: 0x5c });
    expect(parse('\\!')).toEqual({ kind: 'char', codePoint: 0x21 });
  });

  test('an unmatched closing brace or bracket is a literal', () => {
    expect(parse('}')).toEqual({ kind: 'char', codePoint: 0x7d });
    expect(parse(']')).toEqual({ kind: 'char', codePoint: 0x5d });
  });
});

describe('parse — unsupported syntax returns null', () => {
  test.each([
    '(?i)abc',
    '(?P<year>\\d{4})',
    '(?=x)',
    '\\p{L}',
    '\\x{41}',
    '\\101',
    '\\a',
    '\\A',
    'foo\\z',
    '\\Qa.b\\E',
    'trailing\\',
    '(unclosed',
    'unopened)',
    '\uD83D',
    '\uDE00',
  ])('%s returns null', (pattern) => {
    expect(parse(pattern)).toBeNull();
  });
});

describe('parse — group depth limit', () => {
  test('deeply nested groups (10000) return null', () => {
    const pattern = '('.repeat(10000) + 'a' + ')'.repeat(10000);
    expect(parse(pattern)).toBeNull();
  });

  test('reasonably nested groups (50) still parse', () => {
    const pattern = '('.repeat(50) + 'a' + ')'.repeat(50);
    const result = parse(pattern);
    expect(result).not.toBeNull();
    expect(result).toEqual({ kind: 'char', codePoint: 0x61 });
  });
});

describe('parse — character classes', () => {
  test('a class becomes ranges', () => {
    expect(parse('[a-z0]')).toEqual({
      kind: 'class',
      negated: false,
      ranges: [
        { lo: 0x61, hi: 0x7a },
        { lo: 0x30, hi: 0x30 },
      ],
    });
  });

  test('a leading caret negates the class', () => {
    expect(parse('[^0-9]')).toEqual({
      kind: 'class',
      negated: true,
      ranges: [{ lo: 0x30, hi: 0x39 }],
    });
  });

  test('a class escape expands to its ranges inside the class', () => {
    expect(parse('[\\d,]')).toEqual({
      kind: 'class',
      negated: false,
      ranges: [
        { lo: 0x30, hi: 0x39 },
        { lo: 0x2c, hi: 0x2c },
      ],
    });
  });

  test('a dash after a class escape is a literal, as in RE2', () => {
    // RE2 reads [\s-a] as whitespace, '-', and 'a' — not as a range whose
    // start is the trailing space of the expanded \s.
    expect(parse('[\\s-a]')).toEqual({
      kind: 'class',
      negated: false,
      ranges: [
        { lo: 0x09, hi: 0x0a },
        { lo: 0x0c, hi: 0x0d },
        { lo: 0x20, hi: 0x20 },
        { lo: 0x2d, hi: 0x2d },
        { lo: 0x61, hi: 0x61 },
      ],
    });
  });

  test('a dash immediately before the closing bracket is a literal', () => {
    expect(parse('[0-9-]')).toEqual({
      kind: 'class',
      negated: false,
      ranges: [
        { lo: 0x30, hi: 0x39 },
        { lo: 0x2d, hi: 0x2d },
      ],
    });
  });

  test('a dash first in the class is a literal', () => {
    expect(parse('[-a]')).toEqual({
      kind: 'class',
      negated: false,
      ranges: [
        { lo: 0x2d, hi: 0x2d },
        { lo: 0x61, hi: 0x61 },
      ],
    });
  });

  test('a non-BMP literal inside a class is one code point', () => {
    expect(parse('[\u{1F600}]')).toEqual({
      kind: 'class',
      negated: false,
      ranges: [{ lo: 0x1f600, hi: 0x1f600 }],
    });
  });

  test.each([
    '[]',
    '[^]',
    '[:alpha:]',
    '[[:alpha:]]',
    '[\\S]',
    '[\\b]',
    '[z-a]',
    '[a-\\d]',
    '[a-z',
    '[\\p{L}]',
  ])('%s returns null', (pattern) => {
    expect(parse(pattern)).toBeNull();
  });
});

describe('parse — quantifiers', () => {
  const a = { kind: 'char', codePoint: 0x61 };

  test('* + ? map to bounds', () => {
    expect(parse('a*')).toEqual({ kind: 'repeat', node: a, min: 0, max: null });
    expect(parse('a+')).toEqual({ kind: 'repeat', node: a, min: 1, max: null });
    expect(parse('a?')).toEqual({ kind: 'repeat', node: a, min: 0, max: 1 });
  });

  test('counted repetitions map to bounds', () => {
    expect(parse('a{2}')).toEqual({ kind: 'repeat', node: a, min: 2, max: 2 });
    expect(parse('a{2,}')).toEqual({ kind: 'repeat', node: a, min: 2, max: null });
    expect(parse('a{1,3}')).toEqual({ kind: 'repeat', node: a, min: 1, max: 3 });
    expect(parse('a{0}')).toEqual({ kind: 'repeat', node: a, min: 0, max: 0 });
  });

  test('a lazy marker is accepted and discarded — acceptance is identical', () => {
    expect(parse('a+?')).toEqual(parse('a+'));
    expect(parse('a{1,3}?')).toEqual(parse('a{1,3}'));
  });

  test('a group can be quantified', () => {
    expect(parse('(?:ab)+')).toEqual({
      kind: 'repeat',
      node: parse('ab'),
      min: 1,
      max: null,
    });
  });

  test('a brace form outside RE2 grammar is literal text', () => {
    expect(parse('a{,2}')).toEqual({
      kind: 'concat',
      nodes: [
        a,
        { kind: 'char', codePoint: 0x7b },
        { kind: 'char', codePoint: 0x2c },
        { kind: 'char', codePoint: 0x32 },
        { kind: 'char', codePoint: 0x7d },
      ],
    });
    // Leading zeroes are not RE2's decimal grammar.
    expect(parse('a{01}')).not.toBeNull();
    expect((parse('a{01}') as { kind: string }).kind).toBe('concat');
  });

  test('RE2 caps a repeat count at 1000', () => {
    expect(RE2_MAX_REPEAT).toBe(1000);
    expect(parse('a{1000}')).not.toBeNull();
  });

  test.each([
    'a{1001}',
    'a{1,1001}',
    'a{1,999999999999999999999999999}',
    'a{3,2}',
    '*a',
    '+a',
    '{2}a',
    'a**',
    'a+*',
    '^*',
  ])('%s returns null', (pattern) => {
    expect(parse(pattern)).toBeNull();
  });

  test('patterns from issue #21 now parse', () => {
    expect(parse('^\\d{3}-\\d{4}$')).not.toBeNull();
    expect(parse('^(yes|no)$')).not.toBeNull();
    expect(parse('[a-z]+@[a-z]+\\.[a-z]+')).not.toBeNull();
  });

  test('a{1000} shape is exactly { kind: repeat, node: char, min: 1000, max: 1000 }', () => {
    expect(parse('a{1000}')).toEqual({
      kind: 'repeat',
      node: { kind: 'char', codePoint: 0x61 },
      min: 1000,
      max: 1000,
    });
  });

  test('triple ? is a double repeat and returns null', () => {
    expect(parse('a???')).toBeNull();
  });

  test('? with no operand returns null', () => {
    expect(parse('?a')).toBeNull();
  });

  test('{1001} bare (not operand-less) returns null', () => {
    expect(parse('{1001}')).toBeNull();
  });

  test('a{1000}{1000} is a double repeat and returns null', () => {
    expect(parse('a{1000}{1000}')).toBeNull();
  });

  test('a long run of { characters does not throw or allocate O(n²)', () => {
    // Ensure we don't exhaust the argument list or cause O(n²) allocation.
    // Each { by itself is a literal character since it's not a valid quantifier.
    const longBraceRun = '{'.repeat(200000);
    const result = parse(longBraceRun);
    // The parse should succeed: it's a concat of 200,000 literal { characters.
    // The point is that it should do so without throwing, without O(n²) allocation,
    // and without hitting the spread operator's argument limit.
    expect(result).not.toBeNull();
    expect((result as { kind: string }).kind).toBe('concat');
  });

  test('a long digit run with closing brace does not throw', () => {
    // Regression: unbounded spread in Number(String.fromCodePoint(...cps)) on the min value
    const longDigitRun = 'a{' + '1'.repeat(200000) + '}';
    expect(() => parse(longDigitRun)).not.toThrow();
    expect(parse(longDigitRun)).toBeNull(); // exceeds RE2_MAX_REPEAT
  });

  test('a long digit run without closing brace does not throw', () => {
    // Regression: worse case — this is not a quantifier (no closing brace)
    // but min is materialized before the } check, causing a throw
    const longDigitRunNoBrace = 'a{' + '1'.repeat(200000);
    expect(() => parse(longDigitRunNoBrace)).not.toThrow();
    expect(parse(longDigitRunNoBrace)).not.toBeNull(); // literal text: 'a' + '{' + many '1's
  });
});
