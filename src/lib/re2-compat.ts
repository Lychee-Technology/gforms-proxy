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
 * both without flags), alternation, quantifiers, character classes and
 * ranges, capturing and (?: groups.
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
 * named groups, and patterns containing surrogates (non-BMP literals are
 * conservatively delegated to Google rather than re-encoded).
 */

export const JS_REGEX_FLAGS = 'u';

// One RE2 `.`: any code point except \n. Under the u flag a negated class
// matches a full code point atomically, unlike `.` without flags, which also
// excludes \r and Unicode line separators.
const DOT = '[^\\n]';
const RE2_SPACE = '\\t\\n\\f\\r ';
// {n} {n,} {n,m} — the only brace forms both engines read as quantifiers.
const QUANTIFIER = /^\{\d+(?:,\d*)?\}/;

const isHexPair = (s: string): boolean => /^[0-9A-Fa-f]{2}$/.test(s);
const isAsciiPunct = (c: string): boolean =>
  c.charCodeAt(0) < 128 && !/[A-Za-z0-9]/.test(c);
const hexEscape = (c: string): string =>
  '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0');

export function toJavaScriptRegexSource(pattern: string): string | null {
  let out = '';
  let inClass = false;
  for (let i = 0; i < pattern.length; ) {
    const ch = pattern[i] as string;
    const code = ch.charCodeAt(0);
    if (code >= 0xd800 && code <= 0xdfff) return null;
    if (ch === '\\') {
      const next = pattern[i + 1];
      if (next === undefined) return null;
      if ('dDwWtnrfv'.includes(next)) {
        out += '\\' + next;
        i += 2;
      } else if (!inClass && (next === 'b' || next === 'B')) {
        out += '\\' + next;
        i += 2;
      } else if (next === 's') {
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
    } else if (inClass) {
      if (ch === ']') inClass = false;
      else if (ch === '[' && pattern[i + 1] === ':') return null;
      out += ch;
      i++;
    } else if (ch === '.') {
      out += DOT;
      i++;
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
    } else if (ch === '(' && pattern[i + 1] === '?') {
      if (pattern[i + 2] !== ':') return null;
      out += '(?:';
      i += 3;
    } else if (ch === '{') {
      // Both engines read {n}/{n,}/{n,m} as a quantifier; any other brace is
      // a literal in RE2, which the u flag only accepts escaped.
      const quant = QUANTIFIER.exec(pattern.slice(i));
      if (quant) {
        out += quant[0];
        i += quant[0].length;
      } else {
        out += hexEscape(ch);
        i++;
      }
    } else if (ch === '}' || ch === ']') {
      // Literal in RE2 outside a class/quantifier; the u flag rejects it bare.
      out += hexEscape(ch);
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return inClass ? null : out;
}
