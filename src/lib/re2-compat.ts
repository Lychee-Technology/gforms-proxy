/**
 * Translates a Google Forms (RE2) pattern into JavaScript RegExp source with
 * identical semantics, or returns null when the pattern uses anything outside
 * a verified JavaScript-compatible subset. The caller skips validation for
 * null and lets Google judge (ADR 0002) — unknown syntax is never guessed at,
 * so a construct missing from the whitelist fails open instead of being
 * silently misread.
 *
 * Output must be compiled with JS_REGEX_FLAGS ('u'). RE2 matches over code
 * points; JavaScript without the u flag matches UTF-16 code units, letting a
 * backtracking engine satisfy two single-character constructs (`..`, `\S\S`,
 * `[^x][^x]`) with the two halves of one surrogate pair. The u flag makes
 * every construct code-point-atomic, closing that gap wholesale.
 *
 * Verified-identical and kept as-is: literals, \d \D \w \W (ASCII in both),
 * \b \B outside classes, \t \n \r \f \v, two-digit \xHH, ^ $ (end of text in
 * both without flags), character classes and ranges, capturing and (?:
 * groups. At most one single-atom quantifier is accepted; unbounded
 * quantifiers additionally require a leading ^ anchor.
 *
 * Translated exactly: `.` becomes [^\n] (RE2's dot also matches \r and
 * Unicode line separators); \s / \S become RE2's ASCII class [\t\n\f\r ]
 * (JavaScript's add Unicode whitespace); escaped ASCII punctuation and
 * literal { } ] are emitted as \xHH escapes, because the u flag rejects
 * identity escapes of non-syntax characters and lone brace/bracket literals
 * that both engines otherwise accept.
 *
 * Everything else returns null: inline flags, \A \z \Q...\E \p \C \a, braced
 * hex and octal/backreference digit escapes, POSIX classes, lookarounds,
 * named groups, alternation, and lone surrogate code units. Well-formed
 * surrogate pairs are preserved and become one code-point atom under the u
 * flag.
 */

export const JS_REGEX_FLAGS = 'u';

// One RE2 `.`: any code point except \n. Under the u flag a negated class
// matches a full code point atomically, unlike `.` without flags, which also
// excludes \r and Unicode line separators.
const DOT = '[^\\n]';
const RE2_SPACE = '\\t\\n\\f\\r ';
// RE2 decimal counts are 0 or a nonzero digit followed by digits. Brace forms
// with leading zeroes are literals rather than quantifiers.
const QUANTIFIER = /^\{(0|[1-9]\d*)(?:,(0|[1-9]\d*)?)?\}/;
const RE2_MAX_REPEAT = 1000;

const isHexPair = (s: string): boolean => /^[0-9A-Fa-f]{2}$/.test(s);
const isAsciiPunct = (c: string): boolean =>
  c.charCodeAt(0) < 128 && !/[A-Za-z0-9]/.test(c);
const hexEscape = (c: string): string =>
  '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0');

export function toJavaScriptRegexSource(pattern: string): string | null {
  let out = '';
  let inClass = false;
  let repetitionSeen = false;
  let canBeLazy = false;
  let quantifiable: 'atom' | 'group' | null = null;
  for (let i = 0; i < pattern.length; ) {
    const ch = pattern[i] as string;
    const code = ch.charCodeAt(0);
    if (ch === '?' && canBeLazy) {
      out += ch;
      i++;
      canBeLazy = false;
      quantifiable = null;
      continue;
    }
    canBeLazy = false;

    if (!inClass) {
      const braceQuantifier =
        ch === '{' ? QUANTIFIER.exec(pattern.slice(i)) : null;
      const quantifier = '*+?'.includes(ch) ? ch : braceQuantifier?.[0];
      if (quantifier !== undefined) {
        if (repetitionSeen || quantifiable !== 'atom') return null;
        if (
          braceQuantifier &&
          [braceQuantifier[1], braceQuantifier[2]].some(
            (bound) =>
              bound !== undefined &&
              bound !== '' &&
              Number(bound) > RE2_MAX_REPEAT,
          )
        ) {
          return null;
        }
        const unbounded =
          ch === '*' || ch === '+' || quantifier.endsWith(',}');
        if (unbounded && !pattern.startsWith('^')) return null;
        repetitionSeen = true;
        out += quantifier;
        i += quantifier.length;
        canBeLazy = true;
        quantifiable = null;
        continue;
      }
    }

    if (code >= 0xd800 && code <= 0xdbff) {
      const low = pattern.charCodeAt(i + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return null;
      out += ch + pattern[i + 1];
      i += 2;
      if (!inClass) quantifiable = 'atom';
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return null;
    } else if (ch === '\\') {
      const next = pattern[i + 1];
      if (next === undefined) return null;
      if ('dDwWtnrfv'.includes(next)) {
        out += '\\' + next;
        i += 2;
      } else if (!inClass && (next === 'b' || next === 'B')) {
        out += '\\' + next;
        i += 2;
      } else if (next === 's') {
        // In-class expansion ends with a literal space; a following range
        // dash would read it as a range start (RE2 keeps the dash literal
        // after a class escape). A dash immediately before ] is literal in
        // both engines.
        if (inClass && pattern[i + 2] === '-' && pattern[i + 3] !== ']') {
          return null;
        }
        out += inClass ? RE2_SPACE : `[${RE2_SPACE}]`;
        i += 2;
      } else if (next === 'S' && !inClass) {
        out += `[^${RE2_SPACE}]`;
        i += 2;
      } else if (next === 'x' && isHexPair(pattern.slice(i + 2, i + 4))) {
        out += pattern.slice(i, i + 4);
        i += 4;
      } else if (isAsciiPunct(next)) {
        // The u flag rejects identity escapes of non-syntax punctuation
        // (\!, \-, \@ …); a hex escape means the same thing in both engines.
        out += hexEscape(next);
        i += 2;
      } else {
        return null;
      }
      if (!inClass) quantifiable = 'atom';
    } else if (inClass) {
      if (ch === ']') {
        inClass = false;
        quantifiable = 'atom';
      } else if (ch === '[' && pattern[i + 1] === ':') return null;
      out += ch;
      i++;
    } else if (ch === '.') {
      out += DOT;
      i++;
      quantifiable = 'atom';
    } else if (ch === '[') {
      out += ch;
      i++;
      if (pattern[i] === '^') {
        out += '^';
        i++;
      }
      // Leading ']' or a POSIX-style ':' right after the bracket parse
      // differently across engines.
      if (pattern[i] === ']' || pattern[i] === ':') return null;
      inClass = true;
      quantifiable = null;
    } else if (ch === '(' && pattern[i + 1] === '?') {
      if (pattern[i + 2] !== ':') return null;
      out += '(?:';
      i += 3;
      quantifiable = null;
    } else if (ch === '(') {
      out += ch;
      i++;
      quantifiable = null;
    } else if (ch === ')') {
      out += ch;
      i++;
      quantifiable = 'group';
    } else if (ch === '{') {
      // Any brace form not consumed as a quantifier is a literal in RE2,
      // which the u flag only accepts escaped.
      out += hexEscape(ch);
      i++;
      quantifiable = 'atom';
    } else if (ch === '}' || ch === ']') {
      // Literal in RE2 outside a class/quantifier; the u flag rejects it bare.
      out += hexEscape(ch);
      i++;
      quantifiable = 'atom';
    } else if (ch === '|') {
      return null;
    } else if (ch === '^' || ch === '$') {
      out += ch;
      i++;
      quantifiable = null;
    } else {
      out += ch;
      i++;
      quantifiable = 'atom';
    }
  }
  return inClass ? null : out;
}
