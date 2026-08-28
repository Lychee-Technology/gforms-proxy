/**
 * Thompson NFA simulation: a set of active instruction pointers advances one
 * input code point at a time, so matching is O(n·m·R) with no backtracking and
 * no shape-dependent cliff (ADR 0005). n is the input length in code points, m
 * the instruction count, and R the number of ranges in a single `char`
 * instruction's class, which `inRanges` scans linearly. All three are bounded:
 * MAX_PROGRAM_SIZE bounds m, MAX_TOTAL_CLASS_RANGES bounds the ranges the whole
 * program can carry and so the R reachable at one position, and the caller caps
 * n — `validator.ts` skips the check for a value over its code-point limit
 * rather than handing it here, because `test` returns a boolean and must not
 * acquire a third "don't know" state. The product is therefore bounded in
 * magnitude, not only in shape.
 *
 * There are no captures and no leftmost-longest bookkeeping. A JSON Schema
 * `pattern` asks only whether a match exists, which also makes greedy and lazy
 * repetition equivalent — the parser never records greediness.
 */
import type { Assertion, CharRange } from './ast.js';
import type { Inst } from './program.js';

const inRanges = (cp: number, ranges: readonly CharRange[]): boolean =>
  ranges.some((range) => cp >= range.lo && cp <= range.hi);

// \w in RE2 is ASCII, as it is in JavaScript without the i and u-property flags.
const isWord = (cp: number | undefined): boolean =>
  cp !== undefined &&
  ((cp >= 0x30 && cp <= 0x39) ||
    (cp >= 0x41 && cp <= 0x5a) ||
    cp === 0x5f ||
    (cp >= 0x61 && cp <= 0x7a));

const holds = (assertion: Assertion, cps: number[], pos: number): boolean => {
  switch (assertion) {
    case 'start':
      return pos === 0;
    case 'end':
      return pos === cps.length;
    case 'word':
      return isWord(cps[pos - 1]) !== isWord(cps[pos]);
    case 'notWord':
      return isWord(cps[pos - 1]) === isWord(cps[pos]);
  }
};

export function matches(prog: Inst[], input: string): boolean {
  // Iterating the string yields code points, so every construct is
  // code-point-atomic and a surrogate pair can never satisfy two atoms.
  const cps = [...input].map((c) => c.codePointAt(0) as number);

  // A generation stamp per instruction keeps each epsilon closure O(m) and
  // terminates a nullable loop body such as (?:a?)* — an instruction is
  // entered at most once per input position.
  const seen = new Int32Array(prog.length).fill(-1);
  let generation = -1;
  let pending: number[] = [];

  const addThread = (list: number[], start: number, pos: number): void => {
    const stack = [start];
    while (stack.length > 0) {
      const pc = stack.pop() as number;
      if (seen[pc] === generation) continue;
      seen[pc] = generation;
      const inst = prog[pc] as Inst;
      if (inst.op === 'jmp') {
        stack.push(inst.x);
      } else if (inst.op === 'split') {
        stack.push(inst.y);
        stack.push(inst.x);
      } else if (inst.op === 'assert') {
        if (holds(inst.assertion, cps, pos)) stack.push(pc + 1);
      } else {
        list.push(pc);
      }
    }
  };

  for (let pos = 0; pos <= cps.length; pos++) {
    generation++;
    const active: number[] = [];
    for (const pc of pending) addThread(active, pc, pos);
    // Seeding the start instruction at every position is what makes the search
    // unanchored, matching RegExp.prototype.test.
    addThread(active, 0, pos);

    const next: number[] = [];
    for (const pc of active) {
      const inst = prog[pc] as Inst;
      if (inst.op === 'match') return true;
      if (inst.op === 'char' && pos < cps.length) {
        const cp = cps[pos] as number;
        if (inRanges(cp, inst.ranges) !== inst.negated) next.push(pc + 1);
      }
    }
    pending = next;
  }

  return false;
}
