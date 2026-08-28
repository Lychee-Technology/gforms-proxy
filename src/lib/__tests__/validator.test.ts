import { describe, test, expect, vi, afterEach } from 'vitest';
import { validate } from '../validator.js';
import { compilePattern } from '../re2/index.js';

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

  test('fails pattern', () => {
    const schema = { type: 'object', properties: { code: { type: 'string', pattern: '^[A-Z]+$' } } };
    const errors = validate({ code: 'abc' }, schema);
    expect(errors.some((e) => e.field === 'code')).toBe(true);
  });

  test('passes pattern', () => {
    const schema = { type: 'object', properties: { code: { type: 'string', pattern: '^[A-Z]+$' } } };
    expect(validate({ code: 'ABC' }, schema)).toEqual([]);
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
        code: { type: 'string', allOf: [{ pattern: '^[A-Z]' }, { minLength: 3 }] },
      },
    };
    expect(validate({ code: 'ABC' }, schema)).toEqual([]);
    const errors = validate({ code: 'ab' }, schema);
    expect(errors.some((e) => e.field === 'code')).toBe(true);
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

describe('validate — uncompilable (RE2-only) patterns', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('does not throw and skips the pattern check', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = {
      type: 'object',
      properties: { code: { type: 'string', pattern: '(?i)abc' } },
    };
    expect(() => validate({ code: 'anything' }, schema)).not.toThrow();
    expect(validate({ code: 'anything' }, schema)).toEqual([]);
  });

  test('other constraints on the same property still apply', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = {
      type: 'object',
      properties: {
        code: { type: 'string', pattern: '(?i)def', minLength: 5 },
      },
    };
    const errors = validate({ code: 'ab' }, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('at least 5');
  });

  test('warns once per unique pattern across repeated validations', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = {
      type: 'object',
      properties: { code: { type: 'string', pattern: '(?i)ghi' } },
    };
    validate({ code: 'x' }, schema);
    validate({ code: 'y' }, schema);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('skips a not-constraint whose pattern is uncompilable instead of rejecting everything', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          allOf: [{ not: { pattern: '(?i)jkl' } }],
        },
      },
    };
    expect(validate({ code: 'whatever' }, schema)).toEqual([]);
  });

  test('valid not-constraint patterns still reject matching values', () => {
    const schema = {
      type: 'object',
      properties: {
        code: { type: 'string', allOf: [{ not: { pattern: '^forbidden$' } }] },
      },
    };
    expect(validate({ code: 'forbidden' }, schema)).toHaveLength(1);
    expect(validate({ code: 'allowed' }, schema)).toEqual([]);
  });
});

describe('validate — RE2 constructs that compile in JavaScript with different semantics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('skips a pattern containing RE2 \\z instead of misreading it as literal z', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = {
      type: 'object',
      properties: { code: { type: 'string', pattern: '^(?:foo\\z)$' } },
    };
    expect(validate({ code: 'foo' }, schema)).toEqual([]);
    expect(validate({ code: 'fooz' }, schema)).toEqual([]);
  });

  test('skips \\Q...\\E quoting and \\p{...} classes, warning once each', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const quoted = {
      type: 'object',
      properties: { code: { type: 'string', pattern: '\\Qa.b\\E' } },
    };
    const unicodeClass = {
      type: 'object',
      properties: { code: { type: 'string', pattern: '\\p{L}+' } },
    };
    expect(validate({ code: 'x' }, quoted)).toEqual([]);
    expect(validate({ code: 'x' }, unicodeClass)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test('skips POSIX character classes like [[:alpha:]]', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = {
      type: 'object',
      properties: { code: { type: 'string', pattern: '^[[:alpha:]]+$' } },
    };
    expect(validate({ code: '123' }, schema)).toEqual([]);
  });

  test('an escaped backslash before z is not RE2 \\z and stays enforced', () => {
    const schema = {
      type: 'object',
      properties: { code: { type: 'string', pattern: '^a\\\\z$' } },
    };
    expect(validate({ code: 'a\\z' }, schema)).toEqual([]);
    expect(validate({ code: 'az' }, schema)).toHaveLength(1);
  });

  test('skips RE2 \\a (BEL) instead of misreading it as literal a', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = {
      type: 'object',
      properties: { code: { type: 'string', pattern: '^(?:\\a+)$' } },
    };
    expect(validate({ code: 'beep' }, schema)).toEqual([]);
    expect(validate({ code: 'aaa' }, schema)).toEqual([]);
  });

  test('a not-constraint containing RE2 \\a is skipped', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = {
      type: 'object',
      properties: {
        code: { type: 'string', allOf: [{ not: { pattern: '\\a' } }] },
      },
    };
    expect(validate({ code: 'a' }, schema)).toEqual([]);
  });

  test('skips RE2 braced hex escapes like \\x{41}', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = {
      type: 'object',
      properties: { code: { type: 'string', pattern: '^\\x{41}$' } },
    };
    expect(validate({ code: 'B' }, schema)).toEqual([]);
  });

  test('a not-constraint whose pattern uses divergent RE2 syntax is skipped', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = {
      type: 'object',
      properties: {
        code: { type: 'string', allOf: [{ not: { pattern: 'foo\\z' } }] },
      },
    };
    expect(validate({ code: 'fooz' }, schema)).toEqual([]);
  });
});

describe('validate — patterns are evaluated with RE2 semantics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('a matches-style dot pattern accepts U+2028 and \\r like RE2 does', () => {
    const schema = {
      type: 'object',
      properties: { code: { type: 'string', pattern: '^(?:.)$' } },
    };
    expect(validate({ code: ' ' }, schema)).toEqual([]);
    expect(validate({ code: '\r' }, schema)).toEqual([]);
    expect(validate({ code: '\n' }, schema)).toHaveLength(1);
  });

  test('dot matches a full non-BMP code point like RE2 does', () => {
    const schema = {
      type: 'object',
      properties: { code: { type: 'string', pattern: '^(?:.)$' } },
    };
    expect(validate({ code: '\u{1F600}' }, schema)).toEqual([]);
  });

  test('\\s uses RE2 ASCII semantics, not JavaScript Unicode whitespace', () => {
    const schema = {
      type: 'object',
      properties: { code: { type: 'string', pattern: '^\\s$' } },
    };
    expect(validate({ code: ' ' }, schema)).toEqual([]);
    expect(validate({ code: ' ' }, schema)).toHaveLength(1);
  });

  test('constructs outside the verified subset are skipped, not guessed', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = {
      type: 'object',
      properties: { code: { type: 'string', pattern: '(?P<year>19\\d\\d)' } },
    };
    expect(validate({ code: 'anything' }, schema)).toEqual([]);
  });

  test('a matches-style ^..$ counts code points: one emoji rejected, two accepted', () => {
    const schema = {
      type: 'object',
      properties: { code: { type: 'string', pattern: '^(?:..)$' } },
    };
    expect(validate({ code: '\u{1F600}' }, schema)).toHaveLength(1);
    expect(validate({ code: '\u{1F600}\u{1F600}' }, schema)).toEqual([]);
    expect(validate({ code: 'ab' }, schema)).toEqual([]);
  });

  test('a does_not_match-style not ^..$ counts code points: one emoji accepted, two rejected', () => {
    const schema = {
      type: 'object',
      properties: {
        code: { type: 'string', allOf: [{ not: { pattern: '^(?:..)$' } }] },
      },
    };
    expect(validate({ code: '\u{1F600}' }, schema)).toEqual([]);
    expect(validate({ code: '\u{1F600}\u{1F600}' }, schema)).toHaveLength(1);
  });

  test('a compatible emoji literal accepts that emoji and rejects another value', () => {
    const schema = {
      type: 'object',
      properties: { code: { type: 'string', pattern: '^(?:😀)$' } },
    };
    expect(validate({ code: '😀' }, schema)).toEqual([]);
    expect(validate({ code: 'x' }, schema)).toHaveLength(1);
  });
});

describe('validate — patterns that backtrack catastrophically in a native engine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('enforces a nested repetition on a hostile value instead of skipping it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = {
      type: 'object',
      properties: {
        code: { type: 'string', pattern: '^(?:(q+)+)$', minLength: 3 },
      },
    };
    const hostileValue = `${'q'.repeat(100)}x`;

    expect(validate({ code: hostileValue }, schema)).toEqual([
      { field: 'code', message: 'must match pattern: ^(?:(q+)+)$' },
    ]);
    expect(validate({ code: 'x' }, schema)).toEqual([
      { field: 'code', message: 'must be at least 3 character(s)' },
      { field: 'code', message: 'must match pattern: ^(?:(q+)+)$' },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  test('an inverted constraint over a nested repetition is evaluated, not skipped', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          allOf: [{ not: { pattern: '^(?:(r+)+)$', minLength: 1 } }],
        },
      },
    };

    expect(validate({ code: 'x' }, schema)).toEqual([]);
    expect(validate({ code: 'rrr' }, schema)).toHaveLength(1);
  });

  test('evaluates ambiguous alternation without executing it natively', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const nativeTest = RegExp.prototype.test;
    let dangerousPatternExecuted = false;
    vi.spyOn(RegExp.prototype, 'test').mockImplementation(function (
      this: RegExp,
      value: string,
    ) {
      if (this.source.includes('(?:a|aa)')) {
        dangerousPatternExecuted = true;
        return false;
      }
      return nativeTest.call(this, value);
    });
    const pattern = '^' + '(?:a|aa)'.repeat(30) + 'b$';
    const schema = {
      type: 'object',
      properties: { code: { type: 'string', pattern } },
    };

    expect(validate({ code: `${'a'.repeat(60)}c` }, schema)).toEqual([
      { field: 'code', message: `must match pattern: ${pattern}` },
    ]);
    expect(dangerousPatternExecuted).toBe(false);
  });
});

describe('validate — patterns the matcher cannot compile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('an unbalanced group does not throw, warns once, and skips only the pattern check', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = {
      type: 'object',
      properties: { code: { type: 'string', pattern: '(', minLength: 3 } },
    };
    expect(() => validate({ code: 'x' }, schema)).not.toThrow();
    const errors = validate({ code: 'x' }, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('at least 3');
    expect(validate({ code: 'long enough' }, schema)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('unsupported RE2 syntax'),
    );
  });
});

describe('compilePattern', () => {
  test('a supported pattern yields a matcher', () => {
    const result = compilePattern('^\\d{3}-\\d{4}$');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matcher.test('555-1234')).toBe(true);
      expect(result.matcher.test('nope')).toBe(false);
    }
  });

  test('unsupported syntax reports its reason', () => {
    expect(compilePattern('\\p{L}+')).toEqual({
      ok: false,
      reason: 'unsupported RE2 syntax',
    });
  });

  test('an oversized expansion reports its reason', () => {
    expect(compilePattern('(?:a{1000}){1000}')).toEqual({
      ok: false,
      reason: 'pattern too large',
    });
  });

  test('too many class ranges in total reports the same reason', () => {
    // 1000 copies of \w sit exactly on the range budget; one more exceeds it
    // while the instruction budget still has room, so this is the range budget
    // speaking and it reports no new reason of its own.
    expect(compilePattern('\\w{1000}').ok).toBe(true);
    expect(compilePattern('\\w{1000}\\w')).toEqual({
      ok: false,
      reason: 'pattern too large',
    });
  });
});

describe('validator — pattern keyword', () => {
  test('a pattern with alternation is now enforced locally', () => {
    const schema = {
      type: 'object',
      properties: { answer: { type: 'string', pattern: '^(yes|no)$' } },
    };
    expect(validate({ answer: 'yes' }, schema)).toEqual([]);
    expect(validate({ answer: 'maybe' }, schema)).toHaveLength(1);
  });

  test('an unsupported pattern is skipped with one warning, not rejected', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = {
      type: 'object',
      properties: { answer: { type: 'string', pattern: '\\p{Greek}+' } },
    };
    expect(validate({ answer: 'anything' }, schema)).toEqual([]);
    expect(validate({ answer: 'anything' }, schema)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('unsupported RE2 syntax');
    warn.mockRestore();
  });

  test('maxLength is terminal for its property', () => {
    const schema = {
      type: 'object',
      properties: {
        answer: { type: 'string', maxLength: 3, pattern: '^\\d+$' },
      },
    };
    // Only the length error: the pattern check never runs on an oversized
    // string, so the work is one comparison rather than a scan proportional
    // to attacker-chosen length.
    const errors = validate({ answer: 'abcdefgh' }, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('at most 3');
  });
});

/**
 * The input-length cap. `maxLength` bounds n where a schema carries one; these
 * cover the schema that does not. Each test uses a distinct pattern because the
 * warn-once bookkeeping is module-level and lives for the process.
 */
describe('validate — pattern input over the length cap', () => {
  const CAP = 10_000;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('a value over the cap skips the pattern check', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = {
      type: 'object',
      properties: { code: { type: 'string', pattern: '^cap1-[a-z]+$' } },
    };
    expect(validate({ code: 'x'.repeat(CAP + 1) }, schema)).toEqual([]);
  });

  test('a value at the cap is still enforced', () => {
    const schema = {
      type: 'object',
      properties: { code: { type: 'string', pattern: '^cap2-[a-z]+$' } },
    };
    expect(validate({ code: 'x'.repeat(CAP) }, schema)).toHaveLength(1);
    expect(validate({ code: `cap2-${'x'.repeat(CAP - 5)}` }, schema)).toEqual([]);
  });

  test('the cap counts code points, not UTF-16 units', () => {
    // U+1D400 is a surrogate pair, so this value is 12000 UTF-16 units but
    // 6000 code points — under the cap, and still checked.
    const schema = {
      type: 'object',
      properties: { code: { type: 'string', pattern: '^cap3-[a-z]+$' } },
    };
    const value = '\u{1D400}'.repeat(6000);
    expect(value.length).toBe(12000);
    expect(validate({ code: value }, schema)).toHaveLength(1);
  });

  test('a not-constraint skips too instead of inverting into a rejection', () => {
    // Letting the forward check skip while the not branch runs would leave
    // notErrors empty and reject a value the constraint permits.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = {
      type: 'object',
      properties: {
        code: { type: 'string', allOf: [{ not: { pattern: '^cap4-forbidden$' } }] },
      },
    };
    expect(validate({ code: 'x'.repeat(CAP + 1) }, schema)).toEqual([]);
  });

  test('warns once per pattern, not once per oversized request', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = {
      type: 'object',
      properties: { code: { type: 'string', pattern: '^cap5-[a-z]+$' } },
    };
    const value = 'x'.repeat(CAP + 1);
    validate({ code: value }, schema);
    validate({ code: value }, schema);
    validate({ code: `${value}y` }, schema);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('input over 10000 code points');
  });
});
