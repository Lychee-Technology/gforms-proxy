/**
 * Parses a Google Forms (RE2) pattern into an AST, or returns null for
 * anything outside the supported subset. Unknown syntax is never guessed at:
 * a construct missing from this parser fails open, leaving Google as the
 * final judge (ADR 0002, ADR 0005).
 *
 * Semantics that differ between RE2 and JavaScript are resolved here rather
 * than passed through: `.` is any code point except \n (RE2's dot also
 * matches \r and Unicode line separators); \s and \S are RE2's ASCII class
 * [\t\n\f\r ], which excludes \v. \d \D \w \W \b \B are ASCII in both.
 */
import type { CharRange, Node } from './ast.js';

const CP = {
  dollar: 0x24,
  lparen: 0x28,
  rparen: 0x29,
  star: 0x2a,
  plus: 0x2b,
  dash: 0x2d,
  dot: 0x2e,
  colon: 0x3a,
  question: 0x3f,
  lbracket: 0x5b,
  backslash: 0x5c,
  rbracket: 0x5d,
  caret: 0x5e,
  lbrace: 0x7b,
  pipe: 0x7c,
  rbrace: 0x7d,
} as const;

const DIGIT: CharRange[] = [{ lo: 0x30, hi: 0x39 }];
const WORD: CharRange[] = [
  { lo: 0x30, hi: 0x39 },
  { lo: 0x41, hi: 0x5a },
  { lo: 0x5f, hi: 0x5f },
  { lo: 0x61, hi: 0x7a },
];
// RE2's \s excludes \v, unlike JavaScript's.
const SPACE: CharRange[] = [
  { lo: 0x09, hi: 0x0a },
  { lo: 0x0c, hi: 0x0d },
  { lo: 0x20, hi: 0x20 },
];

const CLASS_ESCAPES: Record<string, { ranges: CharRange[]; negated: boolean }> = {
  d: { ranges: DIGIT, negated: false },
  D: { ranges: DIGIT, negated: true },
  w: { ranges: WORD, negated: false },
  W: { ranges: WORD, negated: true },
  s: { ranges: SPACE, negated: false },
  S: { ranges: SPACE, negated: true },
};

const CONTROL_ESCAPES: Record<string, number> = {
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
};

const isAsciiPunct = (cp: number): boolean =>
  cp < 128 &&
  !(cp >= 0x30 && cp <= 0x39) &&
  !(cp >= 0x41 && cp <= 0x5a) &&
  !(cp >= 0x61 && cp <= 0x7a);

const isSurrogate = (cp: number): boolean => cp >= 0xd800 && cp <= 0xdfff;

class Parser {
  private readonly cps: number[];
  private i = 0;
  private depth = 0;

  constructor(pattern: string) {
    // Iterating the string yields code points; a lone surrogate yields its own
    // unpaired value, which parseAtom refuses.
    this.cps = [...pattern].map((c) => c.codePointAt(0) as number);
  }

  parse(): Node | null {
    const node = this.parseAlternation();
    // A leftover character means an unbalanced ')' or a construct the atom
    // parser stopped on.
    if (node === null || this.i < this.cps.length) return null;
    return node;
  }

  private peek(offset = 0): number | undefined {
    return this.cps[this.i + offset];
  }

  private parseAlternation(): Node | null {
    const branches: Node[] = [];
    for (;;) {
      const branch = this.parseConcat();
      if (branch === null) return null;
      branches.push(branch);
      if (this.peek() !== CP.pipe) break;
      this.i++;
    }
    return branches.length === 1 ? (branches[0] as Node) : { kind: 'alt', nodes: branches };
  }

  private parseConcat(): Node | null {
    const nodes: Node[] = [];
    for (;;) {
      const cp = this.peek();
      if (cp === undefined || cp === CP.pipe || cp === CP.rparen) break;
      const atom = this.parseAtom();
      if (atom === null) return null;
      nodes.push(atom);
    }
    if (nodes.length === 0) return { kind: 'empty' };
    return nodes.length === 1 ? (nodes[0] as Node) : { kind: 'concat', nodes };
  }

  private parseAtom(): Node | null {
    const cp = this.peek();
    if (cp === undefined) return null;
    switch (cp) {
      case CP.lparen:
        return this.parseGroup();
      case CP.dot:
        this.i++;
        return { kind: 'class', negated: true, ranges: [{ lo: 0x0a, hi: 0x0a }] };
      case CP.caret:
        this.i++;
        return { kind: 'assert', assertion: 'start' };
      case CP.dollar:
        this.i++;
        return { kind: 'assert', assertion: 'end' };
      case CP.backslash:
        return this.parseEscape();
      case CP.lbracket:
      case CP.star:
      case CP.plus:
      case CP.question:
      case CP.lbrace:
        // Character classes arrive in Task 2, quantifiers in Task 3.
        return null;
      default:
        if (isSurrogate(cp)) return null;
        this.i++;
        return { kind: 'char', codePoint: cp };
    }
  }

  private parseGroup(): Node | null {
    this.depth++;
    if (this.depth > 200) return null;
    this.i++;
    if (this.peek() === CP.question) {
      // Only (?: is supported. (?i), (?P<x>…) and lookarounds are refused.
      if (this.peek(1) !== CP.colon) {
        this.depth--;
        return null;
      }
      this.i += 2;
    }
    const body = this.parseAlternation();
    this.depth--;
    if (body === null) return null;
    if (this.peek() !== CP.rparen) return null;
    this.i++;
    return body;
  }

  private parseEscape(): Node | null {
    const next = this.peek(1);
    if (next === undefined) return null;
    const ch = String.fromCodePoint(next);

    const cls = CLASS_ESCAPES[ch];
    if (cls) {
      this.i += 2;
      return { kind: 'class', negated: cls.negated, ranges: cls.ranges };
    }
    const control = CONTROL_ESCAPES[ch];
    if (control !== undefined) {
      this.i += 2;
      return { kind: 'char', codePoint: control };
    }
    if (ch === 'b' || ch === 'B') {
      this.i += 2;
      return { kind: 'assert', assertion: ch === 'b' ? 'word' : 'notWord' };
    }
    if (ch === 'x') {
      const hex = this.readHexPair();
      if (hex === null) return null;
      return { kind: 'char', codePoint: hex };
    }
    if (isAsciiPunct(next)) {
      this.i += 2;
      return { kind: 'char', codePoint: next };
    }
    // \a \A \z \Q \E \p \C and octal/backreference digits.
    return null;
  }

  /** Consumes `\xHH` and returns its value, or null for `\x{…}` and short forms. */
  private readHexPair(): number | null {
    const hi = this.peek(2);
    const lo = this.peek(3);
    if (hi === undefined || lo === undefined) return null;
    const text = String.fromCodePoint(hi, lo);
    if (!/^[0-9A-Fa-f]{2}$/.test(text)) return null;
    this.i += 4;
    return Number.parseInt(text, 16);
  }
}

export function parse(pattern: string): Node | null {
  return new Parser(pattern).parse();
}
