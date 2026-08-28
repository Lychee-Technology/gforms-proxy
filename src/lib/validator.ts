import { toJavaScriptRegexSource, JS_REGEX_FLAGS } from './re2-compat.js';

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

// Google Forms patterns use RE2 syntax. Each pattern is translated into
// JavaScript source with identical semantics (see re2-compat.ts); a pattern
// outside the verified subset, or one that still fails to compile, is cached
// as null and its check skipped — Google remains the final judge.
const patternCache = new Map<string, RegExp | null>();

function getPattern(pattern: string): RegExp | null {
  let re = patternCache.get(pattern);
  if (re === undefined) {
    const source = toJavaScriptRegexSource(pattern);
    if (source === null) {
      console.warn(`Skipping pattern outside the JavaScript-compatible RE2 subset: ${pattern}`);
      re = null;
    } else {
      try {
        re = new RegExp(source, JS_REGEX_FLAGS);
      } catch {
        console.warn(`Skipping uncompilable pattern: ${pattern}`);
        re = null;
      }
    }
    patternCache.set(pattern, re);
  }
  return re;
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
      errors.push({ field, message: `must be at most ${maxLength} character(s)` });
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
      const re = getPattern(pattern);
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
        // A skipped (uncompilable) pattern inside `not` would leave notErrors
        // empty and invert into rejecting every value — skip the whole
        // constraint instead. This holds however many keys the not-schema
        // carries: rejecting requires the value to match every key including
        // the unevaluable pattern, so a confident rejection is never possible.
        const notPattern = isObject(notSchema) ? notSchema['pattern'] : undefined;
        if (typeof notPattern === 'string' && getPattern(notPattern) === null) {
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
