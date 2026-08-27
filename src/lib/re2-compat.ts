/**
 * Translates a Google Forms (RE2) pattern into JavaScript RegExp source with
 * identical semantics, or returns null when the pattern uses anything outside
 * a verified JavaScript-compatible subset. The caller skips validation for
 * null and lets Google judge (ADR 0002) — unknown syntax is never guessed at,
 * so a construct missing from the whitelist fails open instead of being
 * silently misread.
 *
 * Verified-identical and kept as-is: literals, escaped ASCII punctuation,
 * \d \D \w \W (ASCII in both), \b \B outside classes, \t \n \r \f \v,
 * two-digit \xHH, ^ $ (end of text in both without flags), alternation,
 * quantifiers, character classes and ranges, capturing and (?: groups.
 *
 * Translated exactly: `.` (RE2: any code point except \n; JavaScript also
 * excludes \r and Unicode line separators, and matches code units, not
 * points) and \s / \S (RE2: ASCII [\t\n\f\r ]; JavaScript adds Unicode
 * whitespace).
 *
 * Everything else returns null: inline flags, \A \z \Q...\E \p \C \a, braced
 * hex and octal/backreference digit escapes, POSIX classes, lookarounds,
 * named groups, and patterns containing lone surrogates or non-BMP literals
 * (JavaScript would quantify a code unit where RE2 quantifies a code point).
 */

// One RE2 `.`: a surrogate pair (full code point) or any single unit but \n.
const DOT = '(?:[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]|[^\\n])';
const RE2_SPACE = '\\t\\n\\f\\r ';

const isHexPair = (s: string): boolean => /^[0-9A-Fa-f]{2}$/.test(s);
const isAsciiPunct = (c: string): boolean =>
  c.charCodeAt(0) < 128 && !/[A-Za-z0-9]/.test(c);

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
        out += '\\' + next;
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
    } else {
      out += ch;
      i++;
    }
  }
  return inClass ? null : out;
}
