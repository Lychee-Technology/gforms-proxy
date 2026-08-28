/**
 * Renders the RE2 AST as JavaScript RegExp source with identical semantics.
 *
 * Nothing in the Worker imports this. It exists so the NFA matcher can be
 * differentially tested against a battle-tested engine across the whole
 * supported subset — the property that replaced PR #20's syntactic safety
 * argument (ADR 0005). It lives beside the AST for the same reason
 * pattern-policy.ts lives in src/lib/: it depends on this module and belongs
 * next to it.
 *
 * Every code point is emitted as a \u{…} escape, which the u flag requires for
 * non-BMP values and which sidesteps every metacharacter-escaping question.
 */
import type { CharRange, Node } from './ast.js';

export const JS_REGEX_FLAGS = 'u';

const escapeCodePoint = (cp: number): string => `\\u{${cp.toString(16)}}`;

const renderRange = (range: CharRange): string =>
  range.lo === range.hi
    ? escapeCodePoint(range.lo)
    : `${escapeCodePoint(range.lo)}-${escapeCodePoint(range.hi)}`;

const quantifierSuffix = (min: number, max: number | null): string => {
  if (max === null) {
    if (min === 0) return '*';
    if (min === 1) return '+';
    return `{${min},}`;
  }
  if (min === 0 && max === 1) return '?';
  if (min === max) return `{${min}}`;
  return `{${min},${max}}`;
};

export function toJsSource(node: Node): string {
  switch (node.kind) {
    case 'empty':
      return '(?:)';
    case 'char':
      return escapeCodePoint(node.codePoint);
    case 'class':
      return `[${node.negated ? '^' : ''}${node.ranges.map(renderRange).join('')}]`;
    case 'assert':
      switch (node.assertion) {
        case 'start':
          return '^';
        case 'end':
          return '$';
        case 'word':
          return '\\b';
        case 'notWord':
          return '\\B';
      }
      break;
    case 'concat':
      return node.nodes.map(toJsSource).join('');
    case 'alt':
      return `(?:${node.nodes.map(toJsSource).join('|')})`;
    case 'repeat':
      return `(?:${toJsSource(node.node)})${quantifierSuffix(node.min, node.max)}`;
  }
  // Unreachable: every Node kind is handled above.
  throw new Error('unhandled AST node');
}
