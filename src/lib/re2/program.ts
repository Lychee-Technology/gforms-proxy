/**
 * Compiles the RE2 AST into a flat instruction program for the Thompson NFA
 * simulation in match.ts. Counted repetition expands by copying, so the
 * program size — not the pattern's syntactic shape — is what bounds the work.
 * A program over MAX_PROGRAM_SIZE is refused (ADR 0005).
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

class BudgetExceeded extends Error {}

class Compiler {
  private readonly prog: Inst[] = [];

  private emit(inst: Inst): number {
    if (this.prog.length >= MAX_PROGRAM_SIZE) throw new BudgetExceeded();
    this.prog.push(inst);
    return this.prog.length - 1;
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
