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

/** RE2 rejects a repeat count above this, so a Google Form cannot contain one. */
export const RE2_MAX_REPEAT = 1000;

type Quantifier = { min: number; max: number | null };

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

// The range arrays are readonly because DIGIT/WORD/SPACE are shared module
// constants handed straight to callers; a mutable alias would let one parse
// corrupt \d, \w or \s for the life of the isolate. The type is the guard —
// nothing copies at runtime.
const CLASS_ESCAPES: Record<string, { ranges: readonly CharRange[]; negated: boolean }> = {
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
  private failed = false;

  constructor(pattern: string) {
    // Iterating the string yields code points; a lone surrogate yields its own
    // unpaired value, which parseAtom refuses.
    this.cps = [...pattern].map((c) => c.codePointAt(0) as number);
  }

  parse(): Node | null {
    const node = this.parseAlternation();
    if (this.failed) return null;
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
      const repeated = this.applyQuantifier(atom);
      if (repeated === null) return null;
      nodes.push(repeated);
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
        return this.parseClass();
      case CP.star:
      case CP.plus:
      case CP.question:
        // A repetition operator with no operand is an RE2 error.
        return null;
      case CP.lbrace: {
        const save = this.i;
        const quantifier = this.readQuantifier();
        this.i = save;
        if (quantifier !== null) return null; // repetition with no operand
        this.i++;
        return { kind: 'char', codePoint: CP.lbrace };
      }
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

  private parseClass(): Node | null {
    this.i++;
    let negated = false;
    if (this.peek() === CP.caret) {
      negated = true;
      this.i++;
    }
    // A leading ']' and a leading ':' are both refused (ADR 0005). RE2 reads
    // ']' here as a literal member, so it accepts []a], [^]a] and []-a] where
    // we do not; escaping it, [\]a], compiles. A leading ':' is the POSIX
    // form's prefix. Both parse differently across engines, so both go.
    if (this.peek() === CP.rbracket || this.peek() === CP.colon) return null;

    const ranges: CharRange[] = [];
    while (this.i < this.cps.length && this.peek() !== CP.rbracket) {
      // [[:alpha:]] — the inner POSIX class is not supported.
      if (this.peek() === CP.lbracket && this.peek(1) === CP.colon) return null;

      const item = this.parseClassItem();
      if (item === null) return null;
      if (item.kind === 'ranges') {
        ranges.push(...item.ranges);
        continue;
      }
      // A dash starts a range only between two single code points, and only
      // when it is not the last character before ']'.
      const dashStartsRange =
        this.peek() === CP.dash &&
        this.peek(1) !== undefined &&
        this.peek(1) !== CP.rbracket;
      if (dashStartsRange) {
        this.i++;
        const hi = this.parseClassItem();
        if (hi === null || hi.kind !== 'char') return null;
        if (hi.codePoint < item.codePoint) return null;
        ranges.push({ lo: item.codePoint, hi: hi.codePoint });
        continue;
      }
      ranges.push({ lo: item.codePoint, hi: item.codePoint });
    }
    if (this.peek() !== CP.rbracket) return null;
    this.i++;
    return { kind: 'class', negated, ranges };
  }

  private parseClassItem():
    | { kind: 'char'; codePoint: number }
    | { kind: 'ranges'; ranges: readonly CharRange[] }
    | null {
    const cp = this.peek();
    if (cp === undefined) return null;

    if (cp !== CP.backslash) {
      if (isSurrogate(cp)) return null;
      this.i++;
      return { kind: 'char', codePoint: cp };
    }

    const next = this.peek(1);
    if (next === undefined) return null;
    const ch = String.fromCodePoint(next);

    const cls = CLASS_ESCAPES[ch];
    if (cls) {
      // A negated escape inside a class ([\S]) is set subtraction, which the
      // range representation cannot express; refuse rather than approximate.
      if (cls.negated) return null;
      this.i += 2;
      return { kind: 'ranges', ranges: cls.ranges };
    }
    const control = CONTROL_ESCAPES[ch];
    if (control !== undefined) {
      this.i += 2;
      return { kind: 'char', codePoint: control };
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
    // \b inside a class, \p, \A and friends.
    return null;
  }

  private applyQuantifier(atom: Node): Node | null {
    const spec = this.readQuantifier();
    if (spec === null) return atom;
    // `^*` and friends: RE2's treatment of a quantified assertion is not worth
    // modelling, and refusing fails open.
    if (atom.kind === 'assert') return null;
    // A single trailing '?' is the lazy marker. Greedy and lazy accept the
    // same language, so it is consumed and discarded. Anything further is an
    // RE2 error ("double repeat").
    if (this.peek() === CP.question) this.i++;
    if (this.readQuantifier() !== null) return null;
    return { kind: 'repeat', node: atom, min: spec.min, max: spec.max };
  }

  /**
   * Consumes a quantifier and returns its bounds, or null when the next token
   * is not one. Returns null without consuming for a brace form outside RE2's
   * decimal grammar, which is literal text. A malformed or out-of-range bound
   * also returns null, but additionally sets the failed flag; parse() checks
   * this flag to reject the entire pattern. The flag is load-bearing because
   * two callers cannot tell the two null returns apart, and both take the
   * wrong branch on a failed bound: parseAtom's missing-operand guard falls
   * through to a literal '{' char node, and applyQuantifier's double-repeat
   * guard falls through to a repeat node. Neither returns null; the flag is
   * what rejects the pattern anyway. So an out-of-range bound (a{1001}) fails
   * the whole parse, while brace syntax outside the grammar (a{,2}) leaves the
   * '{' to be treated as a literal character.
   */
  private readQuantifier(): Quantifier | null {
    const cp = this.peek();
    if (cp === CP.star) {
      this.i++;
      return { min: 0, max: null };
    }
    if (cp === CP.plus) {
      this.i++;
      return { min: 1, max: null };
    }
    if (cp === CP.question) {
      this.i++;
      return { min: 0, max: 1 };
    }
    if (cp !== CP.lbrace) return null;

    // Scan the brace form directly: {n}, {n,}, or {n,m}.
    // Each count is 0 or a nonzero digit followed by digits (no leading zeros).
    // Accumulate the value numerically to avoid unbounded spreads and O(n²) allocation.
    const save = this.i;
    this.i++; // skip the '{'

    // Read the first count.
    let min = 0;
    let minDigits = 0;
    if (this.peek() === 0x30) {
      // '0'
      this.i++;
      minDigits = 1;
      min = 0;
    } else if (this.peek() !== undefined && this.peek()! >= 0x31 && this.peek()! <= 0x39) {
      // nonzero digit
      while (
        this.peek() !== undefined &&
        this.peek()! >= 0x30 &&
        this.peek()! <= 0x39
      ) {
        const digit = this.peek()! - 0x30;
        min = min * 10 + digit;
        // Clamp to avoid overflow; once over the limit, stay over.
        if (min > RE2_MAX_REPEAT) min = RE2_MAX_REPEAT + 1;
        this.i++;
        minDigits++;
      }
    }
    if (minDigits === 0) {
      this.i = save;
      return null; // not a brace form
    }

    // Check for comma.
    let max: number | null = min; // default to {n}
    if (this.peek() === 0x2c) {
      // ','
      this.i++;
      let maxVal = 0;
      let maxDigits = 0;
      if (this.peek() === 0x30) {
        // '0'
        this.i++;
        maxDigits = 1;
        maxVal = 0;
      } else if (this.peek() !== undefined && this.peek()! >= 0x31 && this.peek()! <= 0x39) {
        // nonzero digit
        while (
          this.peek() !== undefined &&
          this.peek()! >= 0x30 &&
          this.peek()! <= 0x39
        ) {
          const digit = this.peek()! - 0x30;
          maxVal = maxVal * 10 + digit;
          // Clamp to avoid overflow; once over the limit, stay over.
          if (maxVal > RE2_MAX_REPEAT) maxVal = RE2_MAX_REPEAT + 1;
          this.i++;
          maxDigits++;
        }
      }
      if (maxDigits === 0) {
        max = null; // {n,}
      } else {
        max = maxVal;
      }
    }

    // Check for closing '}'.
    if (this.peek() !== CP.rbrace) {
      this.i = save;
      return null; // not a brace form
    }
    this.i++; // skip the '}'

    // Validate the bounds.
    if (min > RE2_MAX_REPEAT) return this.fail();
    if (max !== null && (max > RE2_MAX_REPEAT || max < min)) return this.fail();

    return { min, max };
  }

  /** Marks the parse as failed; parse() returns null once the flag is set. */
  private fail(): null {
    this.failed = true;
    return null;
  }
}

export function parse(pattern: string): Node | null {
  return new Parser(pattern).parse();
}
