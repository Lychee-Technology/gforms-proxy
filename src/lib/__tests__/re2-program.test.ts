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
    const splits = program.filter((i) => (i as { op: string }).op === 'split') as {
      op: string;
      x: number;
      y: number;
    }[];
    expect(splits).toHaveLength(2);
    // All splits should jump to the same end location
    expect(splits[0]!.y).toBe(splits[1]!.y);
  });

  test('an unbounded repetition emits a loop', () => {
    const program = programFor('a*') as {
      op: string;
      x?: number;
      y?: number;
    }[];
    expect(program.map((i) => i.op)).toEqual(['split', 'char', 'jmp', 'match']);
    const split = program[0] as { op: string; x?: number; y?: number };
    const jmp = program[2] as { op: string; x?: number; y?: number };
    // split.x should point to the char instruction
    expect(split.x).toBe(1);
    // split.y should point to match
    expect(split.y).toBe(3);
    // jmp should loop back to split
    expect(jmp.x).toBe(0);
  });

  test('a+ compiles with mandatory copy and optional loop', () => {
    const program = programFor('a+') as {
      op: string;
      x?: number;
      y?: number;
    }[];
    expect(program).toEqual([
      { op: 'char', negated: false, ranges: [{ lo: 0x61, hi: 0x61 }] },
      { op: 'split', x: 2, y: 4 },
      { op: 'char', negated: false, ranges: [{ lo: 0x61, hi: 0x61 }] },
      { op: 'jmp', x: 1 },
      { op: 'match' },
    ]);
  });

  test('a{0} compiles to only match (empty body)', () => {
    expect(programFor('a{0}')).toEqual([{ op: 'match' }]);
  });

  test('alternation compiles with splits and jumps', () => {
    const program = programFor('a|b|c') as {
      op: string;
      x?: number;
      y?: number;
      negated?: boolean;
      ranges?: unknown;
      assertion?: unknown;
    }[];
    expect(program).toEqual([
      { op: 'split', x: 1, y: 3 },
      { op: 'char', negated: false, ranges: [{ lo: 0x61, hi: 0x61 }] },
      { op: 'jmp', x: 7 },
      { op: 'split', x: 4, y: 6 },
      { op: 'char', negated: false, ranges: [{ lo: 0x62, hi: 0x62 }] },
      { op: 'jmp', x: 7 },
      { op: 'char', negated: false, ranges: [{ lo: 0x63, hi: 0x63 }] },
      { op: 'match' },
    ]);
  });

  test('alternation inside repetition', () => {
    const program = programFor('(?:a|b)*') as {
      op: string;
      x?: number;
      y?: number;
      negated?: boolean;
      ranges?: unknown;
    }[];
    expect(program).toEqual([
      { op: 'split', x: 1, y: 6 },
      { op: 'split', x: 2, y: 4 },
      { op: 'char', negated: false, ranges: [{ lo: 0x61, hi: 0x61 }] },
      { op: 'jmp', x: 5 },
      { op: 'char', negated: false, ranges: [{ lo: 0x62, hi: 0x62 }] },
      { op: 'jmp', x: 0 },
      { op: 'match' },
    ]);
  });

  test('a{1000} fits the budget', () => {
    const program = programFor('a{1000}') as unknown[];
    expect(program.length).toBeLessThanOrEqual(MAX_PROGRAM_SIZE);
  });

  test('a nested expansion beyond the budget returns null', () => {
    expect(programFor('(?:a{1000}){1000}')).toBeNull();
  });

  test('deeply nested empty groups are bounded by work counter', () => {
    const program = programFor('(?:(?:(?:(?:){1000}){1000}){1000}){1000}');
    // Should return null (exceeds budget) or a tiny program (only match)
    if (program !== null) {
      expect(program.length).toBeLessThanOrEqual(10);
    }
  });

  test('the budget is 4000 instructions', () => {
    expect(MAX_PROGRAM_SIZE).toBe(4000);
  });
});
