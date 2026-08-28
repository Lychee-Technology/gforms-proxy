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
// leaves the axis open.
//
// The budget is per `validate()` call, not per value, because one request body
// carries many pattern checks: `schema.ts` can put two `{pattern}` members in
// a single field's `allOf` and a `{not: {pattern}}` on top, and a form has as
// many text fields as its author wrote. Capping each value would leave their
// sum unbounded — ten near-cap values cost ten times one. A shared budget
// bounds the whole request's matching work at n code points, however they are
// spread across fields and constraints.
export const MAX_PATTERN_CODE_POINTS_PER_REQUEST = 10_000;

// Passed down the recursion rather than held in a module-level counter: module
// state would persist across requests in a Worker isolate, so one large body
// would starve every later request served by the same isolate, and it would
// make the tests order-dependent.
interface PatternBudget {
  remaining: number;
}

// Code points, not UTF-16 units: the matcher iterates the string, so a
// surrogate pair is one step to it. Returns null once the count passes `limit`,
// which also bounds the loop itself at limit + 1 iterations.
function codePointCountWithin(value: string, limit: number): number | null {
  let count = 0;
  for (const _cp of value) {
    count++;
    if (count > limit) return null;
  }
  return count;
}

// One warning per pattern, like the compile cache above: an attacker sending
// many oversized bodies must not be able to flood the log.
const oversizedInputWarned = new Set<string>();

function warnBudgetExhausted(pattern: string): void {
  if (oversizedInputWarned.has(pattern)) return;
  oversizedInputWarned.add(pattern);
  console.warn(
    `Skipping pattern (over the remaining request budget of ` +
      `${MAX_PATTERN_CODE_POINTS_PER_REQUEST} code points): ${pattern}`,
  );
}

// Whether this pattern check can be evaluated at all, without charging the
// budget. The `not` branch asks before it inverts a result, and the recursive
// call it then makes is what charges — asking here must not double-charge.
function isPatternEvaluable(pattern: string, value: unknown, budget: PatternBudget): boolean {
  if (getPattern(pattern) === null) return false;
  if (typeof value !== 'string') return true;
  if (codePointCountWithin(value, budget.remaining) !== null) return true;
  warnBudgetExhausted(pattern);
  return false;
}

// The matcher to use for this pattern against this value, or null if the check
// cannot be evaluated — the pattern is outside the supported subset, or the
// value does not fit in what is left of the request's matching budget. A
// returned matcher has already had its input charged against the budget.
// Callers skip an unevaluable check in both directions; Google remains the
// final judge (ADR 0002, ADR 0005).
function matcherFor(pattern: string, value: unknown, budget: PatternBudget): Matcher | null {
  const matcher = getPattern(pattern);
  if (matcher === null) return null;
  if (typeof value === 'string') {
    const count = codePointCountWithin(value, budget.remaining);
    if (count === null) {
      warnBudgetExhausted(pattern);
      return null;
    }
    budget.remaining -= count;
  }
  return matcher;
}

function validateProperty(
  field: string,
  value: unknown,
  schema: Schema,
  errors: ValidationError[],
  budget: PatternBudget,
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
      const re = matcherFor(pattern, value, budget);
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
        validateProperty(`${field}[${i}]`, item, items, errors, budget);
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
        // and a value that does not fit the request's remaining matching
        // budget, so the test is the same one the forward check applies.
        const notPattern = isObject(notSchema) ? notSchema['pattern'] : undefined;
        if (typeof notPattern === 'string' && !isPatternEvaluable(notPattern, value, budget)) {
          continue;
        }
        const notErrors: ValidationError[] = [];
        validateProperty(field, value, notSchema, notErrors, budget);
        if (notErrors.length === 0) {
          errors.push({ field, message: `must not match constraint: ${JSON.stringify(notSchema)}` });
        }
      } else if (isObject(sub)) {
        validateProperty(field, value, sub, errors, budget);
      }
    }
  }

  const anyOf = schema['anyOf'];
  if (Array.isArray(anyOf)) {
    const matched = (anyOf as Schema[]).some((sub) => {
      const subErrors: ValidationError[] = [];
      validateProperty(field, value, sub, subErrors, budget);
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
  // One budget per request, shared by every pattern check this call makes.
  const budget: PatternBudget = { remaining: MAX_PATTERN_CODE_POINTS_PER_REQUEST };
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
        validateProperty(key, data[key], propSchema, errors, budget);
      }
    }
  }

  return errors;
}
