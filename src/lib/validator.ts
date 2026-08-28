import { compilePattern, type Matcher } from './re2/index.js';

export interface ValidationError {
  field: string;
  message: string;
}

type Schema = Record<string, unknown>;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return isObject(value);
    case 'null': return value === null;
    default: return true;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URI_RE = /^https?:\/\/.+/;

// Google Forms patterns use RE2 syntax. Each pattern is parsed and compiled
// for the backtracking-free matcher (see re2/); a pattern outside the
// supported subset is cached as null and its check skipped — Google remains
// the final judge.
const patternCache = new Map<string, Matcher | null>();

function getPattern(pattern: string): Matcher | null {
  let matcher = patternCache.get(pattern);
  if (matcher === undefined) {
    const result = compilePattern(pattern);
    if (result.ok) {
      matcher = result.matcher;
    } else {
      console.warn(`Skipping pattern (${result.reason}): ${pattern}`);
      matcher = null;
    }
    patternCache.set(pattern, matcher);
  }
  return matcher;
}

// Matching costs one step per input code point, so n is the last unbounded
// factor of the matcher's n·m·R (m and R are capped at compile time). A
// schema's `maxLength` bounds n where it exists — it is terminal, so an
// oversized string never reaches the pattern check — but a schema without one
// leaves the axis open. Cap it here too.
const MAX_PATTERN_INPUT_CODE_POINTS = 10_000;

// Code points, not UTF-16 units: the matcher iterates the string, so a
// surrogate pair is one step to it. A UTF-16 length is never below the code
// point count, which makes the cheap check a sound early exit.
function isTooLongToMatch(value: string): boolean {
  if (value.length <= MAX_PATTERN_INPUT_CODE_POINTS) return false;
  let count = 0;
  for (const _cp of value) {
    count++;
    if (count > MAX_PATTERN_INPUT_CODE_POINTS) return true;
  }
  return false;
}

// One warning per pattern, like the compile cache above: an attacker sending
// many oversized bodies must not be able to flood the log.
const oversizedInputWarned = new Set<string>();

// The matcher to use for this pattern against this value, or null if the check
// cannot be evaluated — the pattern is outside the supported subset, or the
// value is too long to run it over. Callers skip an unevaluable check in both
// directions; Google remains the final judge (ADR 0002, ADR 0005).
function matcherFor(pattern: string, value: unknown): Matcher | null {
  const matcher = getPattern(pattern);
  if (matcher === null) return null;
  if (typeof value === 'string' && isTooLongToMatch(value)) {
    if (!oversizedInputWarned.has(pattern)) {
      oversizedInputWarned.add(pattern);
      console.warn(
        `Skipping pattern (input over ${MAX_PATTERN_INPUT_CODE_POINTS} code points): ${pattern}`,
      );
    }
    return null;
  }
  return matcher;
}

function validateProperty(
  field: string,
  value: unknown,
  schema: Schema,
  errors: ValidationError[],
): void {
  const type = schema['type'];
  if (typeof type === 'string' && !checkType(value, type)) {
    errors.push({ field, message: `must be of type ${type}` });
    return;
  }

  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema['const'])) {
    errors.push({ field, message: `must equal ${JSON.stringify(schema['const'])}` });
    return;
  }

  if (Array.isArray(schema['enum'])) {
    const enumValues = schema['enum'] as unknown[];
    if (!enumValues.includes(value)) {
      errors.push({ field, message: `must be one of: ${enumValues.join(', ')}` });
    }
  }

  if (typeof value === 'string') {
    const minLength = schema['minLength'];
    if (typeof minLength === 'number' && value.length < minLength) {
      errors.push({ field, message: `must be at least ${minLength} character(s)` });
    }
    const maxLength = schema['maxLength'];
    if (typeof maxLength === 'number' && value.length > maxLength) {
      // Terminal, like maxItems: returning skips the format and pattern
      // checks below and any allOf/anyOf. An oversized string is already
      // invalid, and matching is linear in its attacker-chosen length.
      errors.push({ field, message: `must be at most ${maxLength} character(s)` });
      return;
    }
    const format = schema['format'];
    if (format === 'email' && !EMAIL_RE.test(value)) {
      errors.push({ field, message: 'must match format: email' });
    }
    if (format === 'uri' && !URI_RE.test(value)) {
      errors.push({ field, message: 'must match format: uri' });
    }
    const pattern = schema['pattern'];
    if (typeof pattern === 'string') {
      const re = matcherFor(pattern, value);
      if (re && !re.test(value)) {
        errors.push({ field, message: `must match pattern: ${pattern}` });
      }
    }
  }

  if (typeof value === 'number') {
    const minimum = schema['minimum'];
    if (typeof minimum === 'number' && value < minimum) {
      errors.push({ field, message: `must be >= ${minimum}` });
    }
    const exclusiveMinimum = schema['exclusiveMinimum'];
    if (typeof exclusiveMinimum === 'number' && value <= exclusiveMinimum) {
      errors.push({ field, message: `must be > ${exclusiveMinimum}` });
    }
    const maximum = schema['maximum'];
    if (typeof maximum === 'number' && value > maximum) {
      errors.push({ field, message: `must be <= ${maximum}` });
    }
    const exclusiveMaximum = schema['exclusiveMaximum'];
    if (typeof exclusiveMaximum === 'number' && value >= exclusiveMaximum) {
      errors.push({ field, message: `must be < ${exclusiveMaximum}` });
    }
  }

  if (Array.isArray(value)) {
    const minItems = schema['minItems'];
    if (typeof minItems === 'number' && value.length < minItems) {
      errors.push({ field, message: `must have at least ${minItems} item(s)` });
    }
    const maxItems = schema['maxItems'];
    if (typeof maxItems === 'number' && value.length > maxItems) {
      // Terminal, like a type mismatch: returning skips the per-item scans
      // below and any allOf/anyOf, because an oversized array is already
      // invalid and scanning it would burn CPU proportional to
      // attacker-chosen length.
      errors.push({ field, message: `must have at most ${maxItems} item(s)` });
      return;
    }
    if (schema['uniqueItems'] === true) {
      const seen = new Set<string>();
      let hasDupe = false;
      for (const item of value) {
        const key = JSON.stringify(item);
        if (seen.has(key)) { hasDupe = true; break; }
        seen.add(key);
      }
      if (hasDupe) errors.push({ field, message: 'items must be unique' });
    }
    const items = schema['items'];
    if (isObject(items)) {
      value.forEach((item, i) => {
        validateProperty(`${field}[${i}]`, item, items, errors);
      });
    }
  }

  const allOf = schema['allOf'];
  if (Array.isArray(allOf)) {
    for (const sub of allOf as Schema[]) {
      if (isObject(sub) && 'not' in sub) {
        const notSchema = sub['not'] as Schema;
        // An unevaluable pattern inside `not` would leave notErrors empty and
        // invert into rejecting every value — skip the whole constraint
        // instead. This holds however many keys the not-schema carries:
        // rejecting requires the value to match every key including the
        // unevaluable pattern, so a confident rejection is never possible. It
        // holds for both ways a check can be unevaluable, uncompilable pattern
        // and over-long value, so the test is the same matcherFor the forward
        // check uses.
        const notPattern = isObject(notSchema) ? notSchema['pattern'] : undefined;
        if (typeof notPattern === 'string' && matcherFor(notPattern, value) === null) {
          continue;
        }
        const notErrors: ValidationError[] = [];
        validateProperty(field, value, notSchema, notErrors);
        if (notErrors.length === 0) {
          errors.push({ field, message: `must not match constraint: ${JSON.stringify(notSchema)}` });
        }
      } else if (isObject(sub)) {
        validateProperty(field, value, sub, errors);
      }
    }
  }

  const anyOf = schema['anyOf'];
  if (Array.isArray(anyOf)) {
    const matched = (anyOf as Schema[]).some((sub) => {
      const subErrors: ValidationError[] = [];
      validateProperty(field, value, sub, subErrors);
      return subErrors.length === 0;
    });
    if (!matched) {
      errors.push({ field, message: 'must match at least one of the allowed schemas' });
    }
  }
}

export function validate(
  data: unknown,
  schema: Record<string, unknown>,
): ValidationError[] {
  if (!isObject(data)) {
    return [{ field: '(root)', message: 'must be a JSON object' }];
  }

  const errors: ValidationError[] = [];
  const properties = schema['properties'];
  const required = schema['required'];
  const additionalProperties = schema['additionalProperties'];

  // Object.hasOwn, not `in`: `in` walks the prototype chain, so keys like
  // "toString" or "constructor" would count as present / allowed.
  if (Array.isArray(required)) {
    for (const key of required as string[]) {
      if (!Object.hasOwn(data, key)) {
        errors.push({ field: key, message: 'is required' });
      }
    }
  }

  if (additionalProperties === false && isObject(properties)) {
    for (const key of Object.keys(data)) {
      if (!Object.hasOwn(properties, key)) {
        errors.push({ field: key, message: 'additional property not allowed' });
      }
    }
  }

  if (isObject(properties)) {
    for (const [key, propSchema] of Object.entries(properties)) {
      if (!Object.hasOwn(data, key)) continue;
      if (isObject(propSchema)) {
        validateProperty(key, data[key], propSchema, errors);
      }
    }
  }

  return errors;
}
