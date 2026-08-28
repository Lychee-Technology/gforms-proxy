/**
 * The AST for the RE2 subset this project evaluates locally. It carries no
 * backtracking-shape information: patterns are executed by a Thompson NFA
 * simulation (see match.ts), so execution safety is a property of the engine,
 * not of the pattern (ADR 0005).
 *
 * Greediness is deliberately absent. The matcher answers only "does this
 * match", and a greedy and a lazy repetition accept the same language.
 * Capturing groups are absent for the same reason.
 */

/** An inclusive code-point range. */
export interface CharRange {
  lo: number;
  hi: number;
}

export type Assertion = 'start' | 'end' | 'word' | 'notWord';

export type Node =
  | { kind: 'empty' }
  | { kind: 'char'; codePoint: number }
  | { kind: 'class'; negated: boolean; ranges: CharRange[] }
  | { kind: 'assert'; assertion: Assertion }
  | { kind: 'concat'; nodes: Node[] }
  | { kind: 'alt'; nodes: Node[] }
  | { kind: 'repeat'; node: Node; min: number; max: number | null };
