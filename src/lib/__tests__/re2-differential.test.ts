import { describe, test, expect } from 'vitest';
import { parse } from '../re2/parser.js';
import { compile } from '../re2/program.js';
import { matches } from '../re2/match.js';
import { toJsSource, JS_REGEX_FLAGS } from '../re2/to-js-source.js';

/**
 * A deterministic xorshift32 PRNG keeps failures reproducible, with a much
 * longer period than the original LCG (15,276). This uses a signed `>>` where
 * canonical xorshift32 uses `>>>`, so it is not the textbook generator and its
 * exact period is unproven; sampling 3,000,000 outputs from this seed found no
 * repeat, which is all the fuzz needs.
 */
const rng = (seed: number) => () => {
  seed ^= seed << 13;
  seed ^= seed >> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 0x100000000;
};

const ATOMS = ['a', 'b', 'c', '\\d', '\\w', '\\s', '.', '[ab]', '[^a]', '[a-c]', '^', '$', '\\b', '\\B'];
/**
 * The atoms on which RE2 and JavaScript-with-`u` agree exactly. `.` and
 * `\s`/`\S` are absent deliberately — they are the two documented semantic
 * divergences, so a raw-text oracle would disagree on them by design.
 */
const JS_AGREEING_ATOMS = [
  'a',
  'b',
  'c',
  '\\d',
  '\\w',
  '\\D',
  '\\W',
  '[ab]',
  '[^a]',
  '[a-c]',
  '[b-d0-9]',
  '^',
  '$',
  '\\b',
  '\\B',
];
const QUANTIFIERS = ['', '', '', '?', '*', '+', '{2}', '{1,2}', '{0,2}', '{2,}'];

const buildPattern = (
  random: () => number,
  depth: number,
  atoms: string[] = ATOMS,
): string => {
  const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)] as T;
  const pieces: number = 1 + Math.floor(random() * 4);
  let out = '';
  for (let k = 0; k < pieces; k++) {
    let unit: string;
    const roll = random();
    if (depth > 0 && roll < 0.25) {
      // Include an empty branch in alternation to test empty patterns (40% of the time).
      const emptyBranch = random() < 0.4;
      if (emptyBranch) {
        unit = `(?:${buildPattern(random, depth - 1, atoms)}|)`;
      } else {
        unit = `(?:${buildPattern(random, depth - 1, atoms)}|${buildPattern(random, depth - 1, atoms)})`;
      }
    } else if (depth > 0 && roll < 0.4) {
      unit = `(?:${buildPattern(random, depth - 1, atoms)})`;
    } else {
      unit = pick(atoms);
    }
    // Assertions cannot be quantified, so emit them without quantifiers.
    const isAssertion = unit === '^' || unit === '$' || unit === '\\b' || unit === '\\B';
    out += unit + (isAssertion ? '' : pick(QUANTIFIERS));
  }
  return out;
};

const buildJsAgreeingPattern = (random: () => number, depth: number): string =>
  buildPattern(random, depth, JS_AGREEING_ATOMS);

const buildInput = (random: () => number): string => {
  const alphabet = 'abc019 \t.\n';
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
    let hasInfiniteQuantifier = false;
    for (let k = 0; k < 1000; k++) {
      const pattern = buildPattern(random, 2);
      const ast = parse(pattern);
      if (ast === null) continue;
      const program = compile(ast);
      if (program === null) continue;
      const source = toJsSource(ast);
      hasInfiniteQuantifier = hasInfiniteQuantifier || (source.includes('{') && source.includes(',}'));
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
    // Measured baseline: 4815 pairs, from 918 distinct patterns with 37
    // rejected by the parser. Floor set to ~90% to catch regressions.
    expect(checked).toBeGreaterThan(4300);
    // Verify {n,} quantifier renderer branch is exercised by fuzz. The \B and
    // empty-alt branches are fuzzed too, not merely table-pinned: both are
    // generated here (\B from ATOMS, empty alt from the `(?:X|)` branch), and
    // a renderer mutant emitting \b for \B fails 175 of these pairs.
    expect(hasInfiniteQuantifier).toBe(true);
  });

  /**
   * The arm above derives both sides from the same AST, so a mis-parse that
   * `to-js-source.ts` renders back consistently is invisible to it: it can
   * only catch a compiler or matcher bug. This arm feeds the original pattern
   * text to the native engine, so the oracle never passes through our AST and
   * a parser mis-parse shows up as a disagreement.
   *
   * The price is that the generator has to stay inside the subset where RE2
   * and JavaScript-with-`u` agree exactly, so `.` and `\s`/`\S` are excluded:
   * RE2's `.` excludes only `\n` (it matches `\r` and U+2028, which JS's `.`
   * does not), and RE2's `\s` is `[\t\n\f\r ]`, excluding `\v`. Both are real
   * documented divergences, so including them would report false
   * disagreements rather than bugs.
   *
   * Size discipline is what keeps the run cheap. The oracle backtracks, and
   * at this sample size the generator does reach ambiguous patterns that cost
   * it seconds apiece: uncapped, ten pairs out of 96,460 accounted for 16.7 s
   * of an 18.0 s run. `MAX_ORACLE_PATTERN_LENGTH` drops those, which is a
   * bound on the oracle's cost, not a filter on any observed disagreement —
   * there are none at any cap measured.
   */
  const MAX_ORACLE_PATTERN_LENGTH = 60;

  test('random pattern/input pairs agree with native RegExp on the raw pattern text', () => {
    const random = rng(20260828);
    let checked = 0;
    let patterns = 0;
    let rejected = 0;
    let skipped = 0;
    for (let k = 0; k < 60000; k++) {
      const pattern = buildJsAgreeingPattern(random, 2);
      if (pattern.length > MAX_ORACLE_PATTERN_LENGTH) {
        skipped++;
        continue;
      }
      const ast = parse(pattern);
      if (ast === null) {
        rejected++;
        continue;
      }
      const program = compile(ast);
      if (program === null) {
        rejected++;
        continue;
      }
      patterns++;
      // The pattern text itself, never routed through our AST.
      const native = new RegExp(pattern, JS_REGEX_FLAGS);
      for (let j = 0; j < 5; j++) {
        const input = buildInput(random);
        expect(
          { pattern, input, ours: matches(program, input) },
          `pattern ${pattern} input ${JSON.stringify(input)}`,
        ).toEqual({ pattern, input, ours: native.test(input) });
        checked++;
      }
    }
    // Guards against the generator degenerating into all-rejected patterns.
    // Measured baseline: 195,225 pairs from 39,045 accepted patterns, with 938
    // rejected by the parser and 20,017 over the length cap. Floor set to ~90%
    // to catch regressions.
    expect(checked).toBeGreaterThan(175000);
    expect(patterns + rejected + skipped).toBe(60000);
  });

  test.each([
    ['^(yes|no)$', ['yes', 'no', 'maybe', '', 'yesno']],
    ['^\\d{3}-\\d{4}$', ['555-1234', '5555-1234', '555-123']],
    ['[a-z]+@[a-z]+\\.[a-z]+', ['a@b.co', 'a@b', '@.']],
    ['\\bcat\\b', ['a cat', 'concatenate', 'cat']],
    ['^[\\s-a]+$', ['-a ', 'b', '\t-']],
    ['^a{0,2}b$', ['b', 'ab', 'aab', 'aaab']],
    ['\\Bcat\\B', ['a cat b', 'concatenate', 'cat', 'scatter']],
    ['^(?:a|)b$', ['b', 'ab', 'aab', '']],
    // Anchored so the row discriminates: unanchored, test() makes a{2,} and
    // a{2} agree on every one of these inputs, and the row would survive the
    // {min,}->{min} renderer mutant it exists to catch. 'aaa' separates them.
    ['^a{2,}$', ['a', 'aa', 'aaa', 'b']],
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
