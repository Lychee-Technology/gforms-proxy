import { describe, test, expect, vi } from 'vitest';
import { validate, MAX_VALIDATION_ERRORS } from '../validator.js';

describe('validate — required fields', () => {
  const schema = {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string' },
      age: { type: 'integer' },
    },
    additionalProperties: false,
  };

  test('passes when required field is present', () => {
    expect(validate({ name: 'Alice' }, schema)).toEqual([]);
  });

  test('fails when required field is missing', () => {
    const errors = validate({}, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe('name');
  });

  test('fails for additional properties when additionalProperties=false', () => {
    const errors = validate({ name: 'Alice', extra: 'bad' }, schema);
    expect(errors.some((e) => e.field === 'extra')).toBe(true);
  });
});

describe('validate — type checking', () => {
  test('fails when string given for integer field', () => {
    const schema = { type: 'object', properties: { age: { type: 'integer' } } };
    const errors = validate({ age: 'not a number' }, schema);
    expect(errors.some((e) => e.field === 'age')).toBe(true);
  });

  test('fails when number is not an integer', () => {
    const schema = { type: 'object', properties: { age: { type: 'integer' } } };
    const errors = validate({ age: 1.5 }, schema);
    expect(errors.some((e) => e.field === 'age')).toBe(true);
  });

  test('passes for number type with float', () => {
    const schema = { type: 'object', properties: { score: { type: 'number' } } };
    expect(validate({ score: 3.14 }, schema)).toEqual([]);
  });

  test('fails when array given for string field', () => {
    const schema = { type: 'object', properties: { name: { type: 'string' } } };
    const errors = validate({ name: ['a'] }, schema);
    expect(errors.some((e) => e.field === 'name')).toBe(true);
  });

  test('passes array type', () => {
    const schema = { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } };
    expect(validate({ tags: ['a', 'b'] }, schema)).toEqual([]);
  });
});

describe('validate — string constraints', () => {
  test('fails minLength', () => {
    const schema = { type: 'object', properties: { name: { type: 'string', minLength: 3 } } };
    const errors = validate({ name: 'ab' }, schema);
    expect(errors.some((e) => e.field === 'name')).toBe(true);
  });

  test('passes minLength', () => {
    const schema = { type: 'object', properties: { name: { type: 'string', minLength: 3 } } };
    expect(validate({ name: 'abc' }, schema)).toEqual([]);
  });

  test('fails maxLength', () => {
    const schema = { type: 'object', properties: { name: { type: 'string', maxLength: 3 } } };
    const errors = validate({ name: 'abcd' }, schema);
    expect(errors.some((e) => e.field === 'name')).toBe(true);
  });

  test('fails email format', () => {
    const schema = { type: 'object', properties: { email: { type: 'string', format: 'email' } } };
    const errors = validate({ email: 'not-an-email' }, schema);
    expect(errors.some((e) => e.field === 'email')).toBe(true);
  });

  test('passes email format', () => {
    const schema = { type: 'object', properties: { email: { type: 'string', format: 'email' } } };
    expect(validate({ email: 'user@example.com' }, schema)).toEqual([]);
  });

  test('fails uri format', () => {
    const schema = { type: 'object', properties: { url: { type: 'string', format: 'uri' } } };
    const errors = validate({ url: 'not a url' }, schema);
    expect(errors.some((e) => e.field === 'url')).toBe(true);
  });

  test('passes uri format', () => {
    const schema = { type: 'object', properties: { url: { type: 'string', format: 'uri' } } };
    expect(validate({ url: 'https://example.com' }, schema)).toEqual([]);
  });

  const dateSchema = { type: 'object', properties: { when: { type: 'string', format: 'date' } } };

  test('passes date format', () => {
    expect(validate({ when: '2026-08-29' }, dateSchema)).toEqual([]);
  });

  test('passes date format on a leap day', () => {
    expect(validate({ when: '2024-02-29' }, dateSchema)).toEqual([]);
  });

  test('fails date format for a non-ISO layout', () => {
    const errors = validate({ when: '29/08/2026' }, dateSchema);
    expect(errors).toEqual([{ field: 'when', message: 'must match format: date' }]);
  });

  test('fails date format for unpadded components', () => {
    const errors = validate({ when: '2026-8-9' }, dateSchema);
    expect(errors.some((e) => e.field === 'when')).toBe(true);
  });

  test('fails date format for a day the month does not have', () => {
    const errors = validate({ when: '2026-02-30' }, dateSchema);
    expect(errors.some((e) => e.field === 'when')).toBe(true);
  });

  test('fails date format for a non-leap February 29', () => {
    const errors = validate({ when: '2026-02-29' }, dateSchema);
    expect(errors.some((e) => e.field === 'when')).toBe(true);
  });

  test('fails date format for an out-of-range month', () => {
    const errors = validate({ when: '2026-13-01' }, dateSchema);
    expect(errors.some((e) => e.field === 'when')).toBe(true);
  });

  test('fails date format for arbitrary text', () => {
    const errors = validate({ when: 'tomorrow' }, dateSchema);
    expect(errors.some((e) => e.field === 'when')).toBe(true);
  });

  const timeSchema = { type: 'object', properties: { at: { type: 'string', format: 'time' } } };

  test('passes time format for HH:MM', () => {
    expect(validate({ at: '09:30' }, timeSchema)).toEqual([]);
  });

  test('passes time format at the ends of the range', () => {
    expect(validate({ at: '00:00' }, timeSchema)).toEqual([]);
    expect(validate({ at: '23:59' }, timeSchema)).toEqual([]);
  });

  // A Google Forms time answer is submitted as entry.X_hour / entry.X_minute
  // (#23) — there is no seconds component to carry a :SS into. Rejecting it
  // is a visible 400 instead of a silently truncated answer.
  test('fails time format for a seconds component', () => {
    const errors = validate({ at: '09:30:00' }, timeSchema);
    expect(errors).toEqual([{ field: 'at', message: 'must match format: time' }]);
  });

  test('fails time format for a non-zero seconds component', () => {
    const errors = validate({ at: '09:30:15' }, timeSchema);
    expect(errors.some((e) => e.field === 'at')).toBe(true);
  });

  test('fails time format for an unpadded hour', () => {
    const errors = validate({ at: '9:30' }, timeSchema);
    expect(errors).toEqual([{ field: 'at', message: 'must match format: time' }]);
  });

  test('fails time format for an out-of-range hour', () => {
    const errors = validate({ at: '24:00' }, timeSchema);
    expect(errors.some((e) => e.field === 'at')).toBe(true);
  });

  test('fails time format for an out-of-range minute', () => {
    const errors = validate({ at: '09:60' }, timeSchema);
    expect(errors.some((e) => e.field === 'at')).toBe(true);
  });

  // A Google Forms time question collects hour and minute, so the RFC 3339
  // offset that Draft 2020-12's `time` requires is rejected rather than
  // accepted (ADR 0002).
  test('fails time format for an RFC 3339 offset', () => {
    const errors = validate({ at: '14:30:00Z' }, timeSchema);
    expect(errors.some((e) => e.field === 'at')).toBe(true);
  });

  test('fails time format for arbitrary text', () => {
    const errors = validate({ at: 'evening' }, timeSchema);
    expect(errors.some((e) => e.field === 'at')).toBe(true);
  });

});

describe('validate — number constraints', () => {
  test('fails minimum', () => {
    const schema = { type: 'object', properties: { age: { type: 'number', minimum: 18 } } };
    const errors = validate({ age: 17 }, schema);
    expect(errors.some((e) => e.field === 'age')).toBe(true);
  });

  test('passes minimum', () => {
    const schema = { type: 'object', properties: { age: { type: 'number', minimum: 18 } } };
    expect(validate({ age: 18 }, schema)).toEqual([]);
  });

  test('fails exclusiveMinimum', () => {
    const schema = { type: 'object', properties: { x: { type: 'number', exclusiveMinimum: 0 } } };
    const errors = validate({ x: 0 }, schema);
    expect(errors.some((e) => e.field === 'x')).toBe(true);
  });

  test('fails maximum', () => {
    const schema = { type: 'object', properties: { score: { type: 'number', maximum: 100 } } };
    const errors = validate({ score: 101 }, schema);
    expect(errors.some((e) => e.field === 'score')).toBe(true);
  });

  test('fails exclusiveMaximum', () => {
    const schema = { type: 'object', properties: { x: { type: 'number', exclusiveMaximum: 10 } } };
    const errors = validate({ x: 10 }, schema);
    expect(errors.some((e) => e.field === 'x')).toBe(true);
  });

  test('fails const', () => {
    const schema = { type: 'object', properties: { val: { const: 42 } } };
    const errors = validate({ val: 43 }, schema);
    expect(errors.some((e) => e.field === 'val')).toBe(true);
  });

  test('passes const', () => {
    const schema = { type: 'object', properties: { val: { const: 42 } } };
    expect(validate({ val: 42 }, schema)).toEqual([]);
  });
});

describe('validate — enum', () => {
  test('fails enum when value not in list', () => {
    const schema = { type: 'object', properties: { color: { type: 'string', enum: ['Red', 'Blue'] } } };
    const errors = validate({ color: 'Green' }, schema);
    expect(errors.some((e) => e.field === 'color')).toBe(true);
  });

  test('passes enum when value in list', () => {
    const schema = { type: 'object', properties: { color: { type: 'string', enum: ['Red', 'Blue'] } } };
    expect(validate({ color: 'Red' }, schema)).toEqual([]);
  });
});

describe('validate — array constraints', () => {
  test('fails minItems', () => {
    const schema = { type: 'object', properties: { tags: { type: 'array', minItems: 1 } } };
    const errors = validate({ tags: [] }, schema);
    expect(errors.some((e) => e.field === 'tags')).toBe(true);
  });

  test('passes minItems', () => {
    const schema = { type: 'object', properties: { tags: { type: 'array', minItems: 1 } } };
    expect(validate({ tags: ['a'] }, schema)).toEqual([]);
  });

  test('fails uniqueItems', () => {
    const schema = { type: 'object', properties: { tags: { type: 'array', uniqueItems: true } } };
    const errors = validate({ tags: ['a', 'a'] }, schema);
    expect(errors.some((e) => e.field === 'tags')).toBe(true);
  });

  test('passes uniqueItems with distinct values', () => {
    const schema = { type: 'object', properties: { tags: { type: 'array', uniqueItems: true } } };
    expect(validate({ tags: ['a', 'b'] }, schema)).toEqual([]);
  });

  test('validates items type', () => {
    const schema = { type: 'object', properties: { nums: { type: 'array', items: { type: 'integer' } } } };
    const errors = validate({ nums: [1, 'two', 3] }, schema);
    expect(errors.some((e) => e.field.startsWith('nums'))).toBe(true);
  });

  test('fails maxItems', () => {
    const schema = { type: 'object', properties: { tags: { type: 'array', maxItems: 2 } } };
    const errors = validate({ tags: ['a', 'b', 'c'] }, schema);
    expect(errors.some((e) => e.field === 'tags')).toBe(true);
  });

  test('passes maxItems at the cap', () => {
    const schema = { type: 'object', properties: { tags: { type: 'array', maxItems: 2 } } };
    expect(validate({ tags: ['a', 'b'] }, schema)).toEqual([]);
  });

  test('maxItems violation short-circuits per-item scans', () => {
    const schema = {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          maxItems: 2,
          uniqueItems: true,
          items: { type: 'string', enum: ['a', 'b'] },
        },
      },
    };
    const errors = validate({ tags: ['zzz', 'zzz', 'zzz'] }, schema);
    expect(errors).toEqual([
      { field: 'tags', message: 'must have at most 2 item(s)' },
    ]);
  });
});

describe('validate — prototype-chain keys', () => {
  const schema = {
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string' } },
    additionalProperties: false,
  };

  test('rejects toString as an additional property', () => {
    const errors = validate(JSON.parse('{"name": "Alice", "toString": "x"}'), schema);
    expect(errors.some((e) => e.field === 'toString')).toBe(true);
  });

  test('rejects constructor as an additional property', () => {
    const errors = validate(JSON.parse('{"name": "Alice", "constructor": "x"}'), schema);
    expect(errors.some((e) => e.field === 'constructor')).toBe(true);
  });

  test('required check does not accept prototype keys as present', () => {
    const protoSchema = {
      type: 'object',
      required: ['constructor'],
      properties: { constructor: { type: 'string' } },
    };
    const errors = validate({}, protoSchema);
    expect(errors).toEqual([{ field: 'constructor', message: 'is required' }]);
  });
});

describe('validate — logical combinators', () => {
  test('allOf: all constraints apply', () => {
    const schema = {
      type: 'object',
      properties: {
        code: { type: 'string', allOf: [{ format: 'email' }, { minLength: 12 }] },
      },
    };
    expect(validate({ code: 'user@example.com' }, schema)).toEqual([]);
    const errors = validate({ code: 'a@b.co' }, schema);
    expect(errors.some((e) => e.field === 'code')).toBe(true);
  });

  test('allOf: applies date format inside a subschema', () => {
    const schema = {
      type: 'object',
      properties: {
        when: { type: 'string', allOf: [{ format: 'date' }] },
      },
    };
    expect(validate({ when: '2026-08-29' }, schema)).toEqual([]);
    const errors = validate({ when: '2026-02-30' }, schema);
    expect(errors.some((e) => e.field === 'when')).toBe(true);
  });

  test('not: negates constraint', () => {
    const schema = {
      type: 'object',
      properties: {
        val: { type: 'number', allOf: [{ not: { const: 0 } }] },
      },
    };
    expect(validate({ val: 1 }, schema)).toEqual([]);
    const errors = validate({ val: 0 }, schema);
    expect(errors.some((e) => e.field === 'val')).toBe(true);
  });

  test('anyOf: at least one must match', () => {
    const schema = {
      type: 'object',
      properties: {
        x: { type: 'number', anyOf: [{ maximum: 0 }, { minimum: 10 }] },
      },
    };
    expect(validate({ x: -1 }, schema)).toEqual([]);
    expect(validate({ x: 15 }, schema)).toEqual([]);
    const errors = validate({ x: 5 }, schema);
    expect(errors.some((e) => e.field === 'x')).toBe(true);
  });
});

describe('validate — optional fields', () => {
  test('skips validation for absent optional fields', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 3 },
      },
    };
    expect(validate({}, schema)).toEqual([]);
  });
});

/**
 * `pattern` is no longer evaluated locally: Google enforces regex rules
 * server-side and rejects a violating submission with HTTP 400, and the
 * matcher that evaluated them here cost far more than a Worker's CPU budget
 * (ADR 0006). `schema.ts` still emits `pattern`, so these schemas are the
 * shapes the validator actually receives.
 */
describe('validate \u2014 the pattern keyword is not enforced locally', () => {
  test('a value that violates its pattern is accepted', () => {
    const schema = {
      type: 'object',
      properties: { code: { type: 'string', pattern: '^[A-Z]+$' } },
    };
    expect(validate({ code: 'abc' }, schema)).toEqual([]);
    expect(validate({ code: 'ABC' }, schema)).toEqual([]);
  });

  test('no warning is logged for any pattern, however exotic', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = {
      type: 'object',
      properties: { code: { type: 'string', pattern: '\\p{Greek}+' } },
    };
    expect(validate({ code: 'anything' }, schema)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test('other constraints on the same property still apply', () => {
    const schema = {
      type: 'object',
      properties: {
        code: { type: 'string', pattern: '^[A-Z]+$', minLength: 5 },
      },
    };
    const errors = validate({ code: 'ab' }, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('at least 5');
  });

  test('maxLength is terminal for its property', () => {
    const schema = {
      type: 'object',
      properties: {
        answer: { type: 'string', maxLength: 3, format: 'email' },
      },
    };
    // Only the length error: an oversized string is already invalid, so the
    // checks below it never run.
    const errors = validate({ answer: 'abcdefgh' }, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('at most 3');
  });

  test('maxLength is terminal ahead of the date format check', () => {
    const schema = {
      type: 'object',
      properties: {
        when: { type: 'string', maxLength: 5, format: 'date' },
      },
    };
    const errors = validate({ when: 'not-a-date-at-all' }, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('at most 5');
  });
});

/**
 * The inversion hazard. `schema.ts` emits `{not: {pattern}}` for
 * does_not_match and does_not_contain. An unevaluated `pattern` yields no
 * inner errors for any value, and inverting that would reject every
 * submission to such a form \u2014 so the whole constraint is skipped.
 */
describe('validate \u2014 a not-constraint carrying a pattern is skipped', () => {
  const schema = {
    type: 'object',
    properties: {
      code: { type: 'string', allOf: [{ not: { pattern: '^forbidden$' } }] },
    },
  };

  test('accepts a value that would have matched the forbidden pattern', () => {
    expect(validate({ code: 'forbidden' }, schema)).toEqual([]);
  });

  test('accepts a value that would not have matched it', () => {
    expect(validate({ code: 'allowed' }, schema)).toEqual([]);
  });

  test('accepts a non-string value rather than inverting into a rejection', () => {
    // The inner `pattern` check only ever ran on strings, so a non-string
    // value produced no inner errors even before this change.
    const untyped = {
      type: 'object',
      properties: {
        code: { allOf: [{ not: { pattern: '^forbidden$' } }] },
      },
    };
    expect(validate({ code: 42 }, untyped)).toEqual([]);
  });

  test('is skipped whatever else the not-schema carries alongside the pattern', () => {
    // A rejection would require the value to match every key of the
    // not-schema, and one of them is the pattern nobody evaluated.
    const withMore = {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          allOf: [{ not: { pattern: '^forbidden$', minLength: 1 } }],
        },
      },
    };
    expect(validate({ code: 'forbidden' }, withMore)).toEqual([]);
    expect(validate({ code: '' }, withMore)).toEqual([]);
  });

  test('a not-constraint without a pattern still negates normally', () => {
    const withoutPattern = {
      type: 'object',
      properties: {
        val: { type: 'number', allOf: [{ not: { const: 0 } }] },
      },
    };
    expect(validate({ val: 1 }, withoutPattern)).toEqual([]);
    expect(validate({ val: 0 }, withoutPattern)).toHaveLength(1);
  });
});

describe('validate — grid objects (named rows, #23)', () => {
  // The shape schema.ts emits for a grid: rows under `properties`, closed by
  // `additionalProperties: false`, all rows required when the question is.
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ratings: {
        type: 'object',
        properties: {
          speed: { type: 'string', enum: ['Yes', 'No'] },
          price: { type: 'string', enum: ['Yes', 'No'] },
        },
        required: ['speed', 'price'],
        additionalProperties: false,
      },
    },
  };

  test('passes a grid whose every row holds an allowed column', () => {
    expect(validate({ ratings: { speed: 'Yes', price: 'No' } }, schema)).toEqual([]);
  });

  test('names the row when a column is not allowed', () => {
    expect(validate({ ratings: { speed: 'Maybe', price: 'No' } }, schema)).toEqual([
      { field: 'ratings.speed', message: 'must be one of: Yes, No' },
    ]);
  });

  test('names the row when its value has the wrong type', () => {
    expect(validate({ ratings: { speed: 1, price: 'No' } }, schema)).toEqual([
      { field: 'ratings.speed', message: 'must be of type string' },
    ]);
  });

  test('reports every offending row, not just the first', () => {
    const errors = validate({ ratings: { speed: 'Maybe', price: 42 } }, schema);
    expect(errors.map((e) => e.field)).toEqual(['ratings.speed', 'ratings.price']);
  });

  test('reports a missing required row', () => {
    expect(validate({ ratings: { speed: 'Yes' } }, schema)).toEqual([
      { field: 'ratings.price', message: 'is required' },
    ]);
  });

  test('rejects a row the schema does not name', () => {
    expect(validate({ ratings: { speed: 'Yes', price: 'No', extra: 'Yes' } }, schema)).toEqual([
      { field: 'ratings.extra', message: 'additional property not allowed' },
    ]);
  });

  test('ignores inherited keys on both sides, like the root does', () => {
    // `toString` is on Object.prototype: neither a present row nor an
    // allowed one.
    const inherited = {
      ...schema,
      properties: { ratings: { ...schema.properties.ratings, required: ['toString'] } },
    };
    expect(validate({ ratings: { speed: 'Yes', price: 'No' } }, inherited)).toEqual([
      { field: 'ratings.toString', message: 'is required' },
    ]);
    expect(validate({ ratings: { speed: 'Yes', price: 'No', toString: 'Yes' } }, schema)).toEqual([
      { field: 'ratings.toString', message: 'additional property not allowed' },
    ]);
  });

  test('validates a checkbox-grid row as an array', () => {
    const multi = {
      type: 'object',
      properties: {
        ratings: {
          type: 'object',
          properties: {
            speed: {
              type: 'array',
              items: { type: 'string', enum: ['A', 'B'] },
              uniqueItems: true,
              maxItems: 2,
            },
          },
          additionalProperties: false,
        },
      },
    };
    expect(validate({ ratings: { speed: ['A', 'B'] } }, multi)).toEqual([]);
    expect(validate({ ratings: { speed: ['A', 'C'] } }, multi)).toEqual([
      { field: 'ratings.speed[1]', message: 'must be one of: A, B' },
    ]);
  });

  test('additionalProperties: false forbids every key when the schema names no properties', () => {
    expect(validate({ x: 1 }, { type: 'object', additionalProperties: false })).toEqual([
      { field: 'x', message: 'additional property not allowed' },
    ]);
    const nested = {
      type: 'object',
      properties: { ratings: { type: 'object', additionalProperties: false } },
    };
    expect(validate({ ratings: { a: 1 } }, nested)).toEqual([
      { field: 'ratings.a', message: 'additional property not allowed' },
    ]);
    expect(validate({ ratings: {} }, nested)).toEqual([]);
  });

  test('a schema without object keywords leaves entries unchecked', () => {
    const loose = { type: 'object', properties: { ratings: { type: 'object' } } };
    expect(validate({ ratings: { anything: 1 } }, loose)).toEqual([]);
  });

  test('depth follows the schema, not the payload', () => {
    // A row schema carries no object keywords, so a nested object inside a
    // row fails the type check and recursion stops there.
    expect(validate({ ratings: { speed: { deep: { deeper: 1 } }, price: 'No' } }, schema)).toEqual([
      { field: 'ratings.speed', message: 'must be of type string' },
    ]);
  });
});

/**
 * The error list is capped (#35). Most error sources are bounded by the
 * schema, but `additionalProperties: false` yields one error per unknown key
 * and `items` one per offending element, so without a budget the caller
 * sizes the 400 response. Past the budget the walk stops and a single marker
 * says so — without a count, because counting means finishing the walk.
 */
describe('validate — error budget (#35)', () => {
  const OMITTED = { field: '(root)', message: 'additional errors omitted' };

  function unknownKeys(count: number): Record<string, number> {
    return Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, 1]));
  }

  test('the budget is 100', () => {
    expect(MAX_VALIDATION_ERRORS).toBe(100);
  });

  test('stops after the budget and appends one marker for unknown keys', () => {
    const schema = { type: 'object', additionalProperties: false };
    const errors = validate(unknownKeys(MAX_VALIDATION_ERRORS * 10), schema);
    expect(errors).toHaveLength(MAX_VALIDATION_ERRORS + 1);
    expect(errors.at(-1)).toEqual(OMITTED);
    for (const e of errors.slice(0, -1)) {
      expect(e.message).toBe('additional property not allowed');
    }
  });

  test('a single omitted error is enough to earn the marker', () => {
    const schema = { type: 'object', additionalProperties: false };
    const errors = validate(unknownKeys(MAX_VALIDATION_ERRORS + 1), schema);
    expect(errors).toHaveLength(MAX_VALIDATION_ERRORS + 1);
    expect(errors.at(-1)).toEqual(OMITTED);
  });

  test('exactly the budget is reported in full, with no marker', () => {
    const schema = { type: 'object', additionalProperties: false };
    const errors = validate(unknownKeys(MAX_VALIDATION_ERRORS), schema);
    expect(errors).toHaveLength(MAX_VALIDATION_ERRORS);
    expect(errors.some((e) => e.field === '(root)')).toBe(false);
  });

  test('bounds the per-item scan of an array with no maxItems', () => {
    // Every registered form's arrays carry `maxItems` (#7), which is terminal.
    // A definition that lacked it would otherwise hand this axis back to the
    // caller, so the budget must hold on its own.
    const schema = {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
    };
    const tags = Array.from({ length: MAX_VALIDATION_ERRORS * 10 }, () => 0);
    const errors = validate({ tags }, schema);
    expect(errors).toHaveLength(MAX_VALIDATION_ERRORS + 1);
    expect(errors[0]).toEqual({ field: 'tags[0]', message: 'must be of type string' });
    expect(errors.at(-1)).toEqual(OMITTED);
  });

  test('the budget is global: a grid object shares it with the root', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        ratings: { type: 'object', additionalProperties: false },
      },
    };
    const half = MAX_VALIDATION_ERRORS / 2;
    const data = { ...unknownKeys(half), ratings: unknownKeys(half + 10) };
    const errors = validate(data, schema);
    expect(errors).toHaveLength(MAX_VALIDATION_ERRORS + 1);
    expect(errors.at(-1)).toEqual(OMITTED);
    expect(errors.filter((e) => e.field.startsWith('ratings.'))).toHaveLength(half);
  });

  test('a `not` probe does not spend the outer budget', () => {
    // The probe collects errors of its own to decide whether the inner schema
    // matched; those must not count against, or be cut short by, the
    // caller's list.
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: { val: { type: 'number', allOf: [{ not: { const: 0 } }] } },
    };
    const data = { ...unknownKeys(MAX_VALIDATION_ERRORS - 1), val: 0 };
    const errors = validate(data, schema);
    expect(errors).toHaveLength(MAX_VALIDATION_ERRORS);
    expect(errors.at(-1)).toEqual({ field: 'val', message: 'must not match constraint: {"const":0}' });
  });

  test('an `anyOf` probe does not spend the outer budget', () => {
    // Mirror of the `not` case: each branch is probed on a sink of its own,
    // so a value that fails every branch costs the caller's list exactly one
    // entry, however many errors the branches themselves produced.
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        val: { type: 'number', anyOf: [{ maximum: 0 }, { minimum: 10 }] },
      },
    };
    const data = { ...unknownKeys(MAX_VALIDATION_ERRORS - 1), val: 5 };
    const errors = validate(data, schema);
    expect(errors).toHaveLength(MAX_VALIDATION_ERRORS);
    expect(errors.at(-1)).toEqual({ field: 'val', message: 'must match at least one of the allowed schemas' });
  });

  test('an `anyOf` branch that overruns its probe still decides correctly', () => {
    // The probe's budget is one. A branch that would emit many errors (a long
    // array against `items`) is cut off after the first, which is all the
    // probe needs: it asks whether the branch matched, not how badly.
    const schema = {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          anyOf: [{ items: { type: 'string' } }, { items: { type: 'boolean' } }],
        },
      },
    };
    const tags = Array.from({ length: MAX_VALIDATION_ERRORS * 10 }, () => 0);
    expect(validate({ tags }, schema)).toEqual([
      { field: 'tags', message: 'must match at least one of the allowed schemas' },
    ]);
    expect(validate({ tags: ['a', 'b'] }, schema)).toEqual([]);
  });
});
