import { describe, test, expect } from 'vitest';
import { parse } from '../re2/parser.js';
import { compile } from '../re2/program.js';
import { matches } from '../re2/match.js';
import { toJsSource, JS_REGEX_FLAGS } from '../re2/to-js-source.js';

/**
 * A small deterministic PRNG keeps failures reproducible: a failing seed can be
 * pasted straight into a focused test.
 */
const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const ATOMS = ['a', 'b', 'c', '\\d', '\\w', '\\s', '.', '[ab]', '[^a]', '[a-c]'];
const QUANTIFIERS = ['', '', '', '?', '*', '+', '{2}', '{1,2}', '{0,2}'];

const buildPattern = (random: () => number, depth: number): string => {
  const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)] as T;
  const pieces: number = 1 + Math.floor(random() * 3);
  let out = '';
  for (let k = 0; k < pieces; k++) {
    let unit: string;
    const roll = random();
    if (depth > 0 && roll < 0.25) {
      unit = `(?:${buildPattern(random, depth - 1)}|${buildPattern(random, depth - 1)})`;
    } else if (depth > 0 && roll < 0.4) {
      unit = `(?:${buildPattern(random, depth - 1)})`;
    } else {
      unit = pick(ATOMS);
    }
    out += unit + pick(QUANTIFIERS);
  }
  return out;
};

const buildInput = (random: () => number): string => {
  const alphabet = 'abc019 \t.';
  const length = Math.floor(random() * 12);
  let out = '';
  for (let k = 0; k < length; k++) {
    out += alphabet[Math.floor(random() * alphabet.length)] as string;
  }
  return out;
};

describe('differential — the matcher agrees with native RegExp over the subset', () => {
  // Patterns and inputs stay small on purpose. Catastrophic backtracking in
  // the native oracle needs both an ambiguous pattern and a long non-matching
  // input; neither is reachable at this scale.
  test('1000 random pattern/input pairs agree', () => {
    const random = rng(20260827);
    let checked = 0;
    for (let k = 0; k < 1000; k++) {
      const pattern = buildPattern(random, 2);
      const ast = parse(pattern);
      if (ast === null) continue;
      const program = compile(ast);
      if (program === null) continue;
      const source = toJsSource(ast);
      const native = new RegExp(source, JS_REGEX_FLAGS);
      for (let j = 0; j < 5; j++) {
        const input = buildInput(random);
        expect(
          { pattern, input, ours: matches(program, input) },
          `pattern ${pattern} source ${source} input ${JSON.stringify(input)}`,
        ).toEqual({ pattern, input, ours: native.test(input) });
        checked++;
      }
    }
    // Guards against the generator degenerating into all-rejected patterns.
    expect(checked).toBeGreaterThan(2000);
  });

  test.each([
    ['^(yes|no)$', ['yes', 'no', 'maybe', '', 'yesno']],
    ['^\\d{3}-\\d{4}$', ['555-1234', '5555-1234', '555-123']],
    ['[a-z]+@[a-z]+\\.[a-z]+', ['a@b.co', 'a@b', '@.']],
    ['\\bcat\\b', ['a cat', 'concatenate', 'cat']],
    ['^[\\s-a]+$', ['-a ', 'b', '\t-']],
    ['^a{0,2}b$', ['b', 'ab', 'aab', 'aaab']],
  ])('%s agrees on its inputs', (pattern, inputs) => {
    const ast = parse(pattern);
    expect(ast).not.toBeNull();
    const program = compile(ast as NonNullable<typeof ast>);
    expect(program).not.toBeNull();
    const native = new RegExp(toJsSource(ast as NonNullable<typeof ast>), JS_REGEX_FLAGS);
    for (const input of inputs) {
      expect([input, matches(program as NonNullable<typeof program>, input)]).toEqual([
        input,
        native.test(input),
      ]);
    }
  });
});
