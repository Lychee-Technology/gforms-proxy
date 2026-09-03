export interface ValidationError {
  field: string;
  message: string;
}

type Schema = Record<string, unknown>;

// Global error budget (#35). Most error sources are bounded by the schema —
// one per declared property, one per `required` entry — but two are bounded
// by the payload: `additionalProperties: false` yields one error per unknown
// key, and `items` one per offending element (bounded today only because the
// generator emits `maxItems` on every array, #7). Without a budget the caller
// sizes the 400 response: 64 KB of two-byte keys was measured at ~8,400
// errors and a 500 KB body. 100 is far more than any form has properties.
export const MAX_VALIDATION_ERRORS = 100;

// The one place errors are collected. `push` drops everything past the
// budget and records that it did, so `validate` can append a single marker
// only when something really was left out, and the payload-driven loops can
// stop walking rather than push into the void. No count of what was dropped:
// counting means finishing the walk, which is the work the budget skips.
class ErrorSink {
  readonly errors: ValidationError[] = [];
  truncated = false;

  constructor(private readonly budget: number) {}

  push(error: ValidationError): void {
    if (this.errors.length >= this.budget) {
      this.truncated = true;
      return;
    }
    this.errors.push(error);
  }
}

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

// RFC 3339 full-date. The regex fixes the layout and the helper does the
// calendar check the regex cannot: 2026-02-30 and 2026-13-01 are well-formed
// but not dates.
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Deliberately NOT Draft 2020-12's `time` (RFC 3339 full-time), which demands
// seconds and a UTC offset. A Google Forms time answer is submitted as
// entry.X_hour / entry.X_minute (#23): there is no component to carry seconds
// or an offset, so accepting `09:30:15` or `14:30:00Z` would mean silently
// dropping part of what the caller sent. HH:MM only; ADR 0002 records the
// deviation and #23 must revisit it if a seconds component ever appears.
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isCalendarDate(value: string): boolean {
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const maxDay = month === 2 && isLeap ? 29 : DAYS_IN_MONTH[month - 1];
  // The month guard above already makes the lookup total; the explicit check
  // is what lets this stay assertion-free under `noUncheckedIndexedAccess`.
  return maxDay !== undefined && day <= maxDay;
}

// The three object keywords `schema.ts` emits: at the root for every form and,
// since #23, on a grid property. `path` names the entry — a bare key at the
// root, `field.row` below it. Object.hasOwn on both sides, not `in`: `in`
// walks the prototype chain, so "toString" would count as present / allowed.
function validateObjectKeywords(
  value: Record<string, unknown>,
  schema: Schema,
  errors: ErrorSink,
  path: (key: string) => string,
): void {
  const required = schema['required'];
  if (Array.isArray(required)) {
    for (const key of required as string[]) {
      if (!Object.hasOwn(value, key)) {
        errors.push({ field: path(key), message: 'is required' });
      }
    }
  }

  // No `properties` means no key is named, so `additionalProperties: false`
  // forbids every key — JSON Schema's reading, not "unchecked".
  const properties = isObject(schema['properties']) ? schema['properties'] : {};

  // Payload-driven: the caller chooses how many keys there are, so this loop
  // and the `items` scan in validateProperty are the two that can overrun the
  // budget. The `properties` descent below stops as well, so no sub-walk
  // starts on a spent budget; `required` and `allOf` are schema-bounded and
  // run to the end.
  if (schema['additionalProperties'] === false) {
    for (const key of Object.keys(value)) {
      if (errors.truncated) return;
      if (!Object.hasOwn(properties, key)) {
        errors.push({ field: path(key), message: 'additional property not allowed' });
      }
    }
  }

  for (const [key, propSchema] of Object.entries(properties)) {
    if (errors.truncated) return;
    if (!Object.hasOwn(value, key)) continue;
    if (isObject(propSchema)) {
      validateProperty(path(key), value[key], propSchema, errors);
    }
  }
}

// `pattern` is deliberately absent from this validator. Google Forms patterns
// are RE2, and Google enforces them server-side: a submission that violates
// only a regex rule comes back from `formResponse` as HTTP 400. Evaluating
// them here duplicated an authoritative gate at a cost no Worker can pay
// (ADR 0006). `schema.ts` still emits `pattern` so the published schema
// describes the form's real rules — we stop enforcing it, not describing it.
function validateProperty(
  field: string,
  value: unknown,
  schema: Schema,
  errors: ErrorSink,
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
      // Terminal, like maxItems: returning skips the format check below and
      // any allOf/anyOf. An oversized string is already invalid, so scanning
      // it further is work proportional to an attacker-chosen length.
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
    if (format === 'date' && !isCalendarDate(value)) {
      errors.push({ field, message: 'must match format: date' });
    }
    if (format === 'time' && !TIME_RE.test(value)) {
      errors.push({ field, message: 'must match format: time' });
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
      for (const [i, item] of value.entries()) {
        if (errors.truncated) return;
        validateProperty(`${field}[${i}]`, item, items, errors);
      }
    }
  }

  // Grid questions are the only objects `schema.ts` emits below the root:
  // rows under `properties`, closed by `additionalProperties: false`. Depth
  // follows the schema, not the payload — a row schema carries no object
  // keywords, so recursion ends one level down however deeply a caller nests
  // JSON. The per-entry work is linear in the body and stays inside the
  // route's 64 KB cap.
  if (isObject(value)) {
    validateObjectKeywords(value, schema, errors, (key) => `${field}.${key}`);
  }

  const allOf = schema['allOf'];
  if (Array.isArray(allOf)) {
    for (const sub of allOf as Schema[]) {
      if (isObject(sub) && 'not' in sub) {
        const notSchema = sub['not'] as Schema;
        // `schema.ts` emits `{not: {pattern}}` for does_not_match and
        // does_not_contain. Since `pattern` is no longer evaluated, the inner
        // schema produces no errors for any value, and inverting that would
        // reject every submission to a form carrying such a rule. Skip the
        // whole constraint instead. This holds however many keys the
        // not-schema carries: a rejection requires the value to match every
        // key, including the pattern nobody evaluated, so a confident
        // rejection is never possible. Google enforces the rule (ADR 0006).
        if (isObject(notSchema) && typeof notSchema['pattern'] === 'string') {
          continue;
        }
        // A probe: only "any error at all" matters, so one is enough. It
        // neither spends the outer budget nor is cut short by it.
        const notErrors = new ErrorSink(1);
        validateProperty(field, value, notSchema, notErrors);
        if (notErrors.errors.length === 0) {
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
      const subErrors = new ErrorSink(1);
      validateProperty(field, value, sub, subErrors);
      return subErrors.errors.length === 0;
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

  const sink = new ErrorSink(MAX_VALIDATION_ERRORS);
  validateObjectKeywords(data, schema, sink, (key) => key);
  if (sink.truncated) {
    sink.errors.push({ field: '(root)', message: 'additional errors omitted' });
  }
  return sink.errors;
}
