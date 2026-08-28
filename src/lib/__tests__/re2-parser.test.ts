import { describe, test, expect } from 'vitest';
import { parse } from '../re2/parser.js';

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
    expect(parse('\\v')).toEqual({ kind: 'char', codePoint: 0x0b });
    expect(parse('\\x41')).toEqual({ kind: 'char', codePoint: 0x41 });
  });

  test('escaped ASCII punctuation is that punctuation', () => {
    expect(parse('\\-')).toEqual({ kind: 'char', codePoint: 0x2d });
    expect(parse('\\|')).toEqual({ kind: 'char', codePoint: 0x7c });
    expect(parse('\\\\')).toEqual({ kind: 'char', codePoint: 0x5c });
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
