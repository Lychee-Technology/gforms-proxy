/**
 * The single entry point for evaluating a Google Forms (RE2) pattern.
 * Returns a matcher, or the reason the pattern is not evaluable locally.
 * Callers skip an unevaluable pattern; Google remains the final judge
 * (ADR 0002, ADR 0005).
 */
import { matches } from './match.js';
import { parse } from './parser.js';
import { compile } from './program.js';

export type CompileFailure = 'unsupported RE2 syntax' | 'pattern too large';

export interface Matcher {
  test(input: string): boolean;
}

export type CompileResult =
  | { ok: true; matcher: Matcher }
  | { ok: false; reason: CompileFailure };

export function compilePattern(pattern: string): CompileResult {
  const ast = parse(pattern);
  if (ast === null) return { ok: false, reason: 'unsupported RE2 syntax' };
  const program = compile(ast);
  if (program === null) return { ok: false, reason: 'pattern too large' };
  return { ok: true, matcher: { test: (input) => matches(program, input) } };
}
