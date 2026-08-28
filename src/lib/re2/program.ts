/**
 * Compiles the RE2 AST into a flat instruction program for the Thompson NFA
 * simulation in match.ts. Counted repetition expands by copying, so the
 * program size — not the pattern's syntactic shape — is what bounds the work.
 * A program over MAX_PROGRAM_SIZE, over MAX_COMPILE_WORK node visits, or
 * carrying more than MAX_TOTAL_CLASS_RANGES class ranges is refused (ADR 0005).
 *
 * Note: The generated program may contain epsilon edges (transitions without
 * consuming input) that form cycles, e.g., from `(?:){1,}` or `(?:a*)*`. The
 * Thompson NFA simulator must maintain a per-position visited set to avoid
 * infinite loops through epsilon paths.
 */
import type { Assertion, CharRange, Node } from './ast.js';

export type Inst =
  | { op: 'char'; negated: boolean; ranges: readonly CharRange[] }
  | { op: 'split'; x: number; y: number }
  | { op: 'jmp'; x: number }
  | { op: 'assert'; assertion: Assertion }
  | { op: 'match' };

/**
 * Comfortably above what one maximal RE2 repetition needs (1000), so ordinary
 * patterns compile while a nested expansion such as (?:a{1000}){1000} — about
 * a million instructions — is refused.
 */
export const MAX_PROGRAM_SIZE = 4000;

/**
 * A second, independent limiter. Compiler work is not the same quantity as
 * emitted instructions: an empty repetition body such as `(?:){1000}` emits
 * nothing yet still costs a node visit per iteration, so without this counter a
 * nested stack of them compiles forever while never touching MAX_PROGRAM_SIZE.
 * The multiplier keeps the whole documented instruction budget reachable (a
 * pattern emitting 4000 instructions costs somewhat more than 4000 visits)
 * while staying many orders of magnitude below the 10^6..10^12 iterations such
 * a nested empty-body attack needs.
 */
const MAX_COMPILE_WORK = 4 * MAX_PROGRAM_SIZE;

/**
 * A third limiter, over the total number of class ranges the program emits.
 * The simulation tests class membership with a linear scan, so a `char`
 * instruction costs its range count rather than O(1), and the work spent at one
 * input position is bounded by the ranges reachable across every active
 * instruction — the program's total, not any single class's maximum. Capping
 * that total is what makes the per-character cost bounded rather than merely
 * finite: without it, 4000 instructions each carrying thousands of ranges would
 * cost far more per character than the instruction budget suggests. The limit
 * is the same order as MAX_PROGRAM_SIZE and far above anything real — `\w`
 * contributes 4 ranges, `\s` 3, `\d` 1, and a hand-written class usually fewer
 * than 10 — so it cannot bite a form an operator would actually onboard. An
 * overrun is reported as "pattern too large", like the other two.
 */
export const MAX_TOTAL_CLASS_RANGES = 4000;

class BudgetExceeded extends Error {}

class Compiler {
  private readonly prog: Inst[] = [];
  private work = 0;
  private ranges = 0;

  private emit(inst: Inst): number {
    if (this.prog.length >= MAX_PROGRAM_SIZE) throw new BudgetExceeded();
    if (inst.op === 'char') {
      this.ranges += inst.ranges.length;
      if (this.ranges > MAX_TOTAL_CLASS_RANGES) throw new BudgetExceeded();
    }
    this.prog.push(inst);
    return this.prog.length - 1;
  }

  private checkWork(): void {
    this.work++;
    if (this.work > MAX_COMPILE_WORK) throw new BudgetExceeded();
  }

  private patch(at: number, field: 'x' | 'y', target: number): void {
    (this.prog[at] as unknown as Record<string, number>)[field] = target;
  }

  compile(node: Node): Inst[] {
    this.node(node);
    this.emit({ op: 'match' });
    return this.prog;
  }

  private node(node: Node): void {
    this.checkWork();

    switch (node.kind) {
      case 'empty':
        return;
      case 'char':
        this.emit({
          op: 'char',
          negated: false,
          ranges: [{ lo: node.codePoint, hi: node.codePoint }],
        });
        return;
      case 'class':
        this.emit({ op: 'char', negated: node.negated, ranges: node.ranges });
        return;
      case 'assert':
        this.emit({ op: 'assert', assertion: node.assertion });
        return;
      case 'concat':
        for (const child of node.nodes) this.node(child);
        return;
      case 'alt':
        this.alt(node.nodes);
        return;
      case 'repeat':
        this.repeat(node.node, node.min, node.max);
        return;
      default: {
        const _exhaustive: never = node;
        void _exhaustive;
        return;
      }
    }
  }

  private alt(branches: Node[]): void {
    const jumps: number[] = [];
    branches.forEach((branch, index) => {
      const isLast = index === branches.length - 1;
      if (isLast) {
        this.node(branch);
        return;
      }
      const split = this.emit({ op: 'split', x: 0, y: 0 });
      this.patch(split, 'x', split + 1);
      this.node(branch);
      jumps.push(this.emit({ op: 'jmp', x: 0 }));
      this.patch(split, 'y', this.prog.length);
    });
    for (const jump of jumps) this.patch(jump, 'x', this.prog.length);
  }

  private repeat(body: Node, min: number, max: number | null): void {
    for (let k = 0; k < min; k++) this.node(body);

    if (max === null) {
      const split = this.emit({ op: 'split', x: 0, y: 0 });
      this.patch(split, 'x', split + 1);
      this.node(body);
      this.emit({ op: 'jmp', x: split });
      this.patch(split, 'y', this.prog.length);
      return;
    }

    const splits: number[] = [];
    for (let k = 0; k < max - min; k++) {
      const split = this.emit({ op: 'split', x: 0, y: 0 });
      this.patch(split, 'x', split + 1);
      splits.push(split);
      this.node(body);
    }
    for (const split of splits) this.patch(split, 'y', this.prog.length);
  }
}

export function compile(node: Node): Inst[] | null {
  try {
    return new Compiler().compile(node);
  } catch (error) {
    if (error instanceof BudgetExceeded) return null;
    throw error;
  }
}
