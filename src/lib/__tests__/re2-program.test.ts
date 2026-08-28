import { describe, test, expect } from 'vitest';
import { parse } from '../re2/parser.js';
import { compile, MAX_PROGRAM_SIZE } from '../re2/program.js';

const programFor = (pattern: string) => {
  const ast = parse(pattern);
  expect(ast).not.toBeNull();
  return compile(ast as NonNullable<typeof ast>);
};

describe('compile', () => {
  test('a literal compiles to a char instruction and a match', () => {
    expect(programFor('a')).toEqual([
      { op: 'char', negated: false, ranges: [{ lo: 0x61, hi: 0x61 }] },
      { op: 'match' },
    ]);
  });

  test('an empty pattern compiles to a bare match', () => {
    expect(programFor('')).toEqual([{ op: 'match' }]);
  });

  test('a counted repetition expands by copying', () => {
    const program = programFor('a{3}') as unknown[];
    expect(program).toHaveLength(4);
    expect(program.filter((i) => (i as { op: string }).op === 'char')).toHaveLength(3);
  });

  test('an optional tail emits one split per optional copy', () => {
    const program = programFor('a{1,3}') as unknown[];
    expect(program.filter((i) => (i as { op: string }).op === 'split')).toHaveLength(2);
  });

  test('an unbounded repetition emits a loop', () => {
    const program = programFor('a*') as { op: string }[];
    expect(program.map((i) => i.op)).toEqual(['split', 'char', 'jmp', 'match']);
  });

  test('a{1000} fits the budget', () => {
    const program = programFor('a{1000}') as unknown[];
    expect(program.length).toBeLessThanOrEqual(MAX_PROGRAM_SIZE);
  });

  test('a nested expansion beyond the budget returns null', () => {
    expect(programFor('(?:a{1000}){1000}')).toBeNull();
  });

  test('the budget is 4000 instructions', () => {
    expect(MAX_PROGRAM_SIZE).toBe(4000);
  });
});
