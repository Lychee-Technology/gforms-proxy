import { describe, expect, test, vi } from 'vitest';
import {
  SAFE_SUBSET_HINT,
  assertDeployablePatterns,
  findSchemaPatternIssues,
} from '../pattern-policy.js';
import { compilePattern } from '../re2/index.js';

describe('findSchemaPatternIssues', () => {
  test('returns no issues for a clean schema', () => {
    const schema = {
      type: 'object',
      properties: {
        code: { type: 'string', pattern: '^[A-Z]{2}$' },
      },
    };

    expect(findSchemaPatternIssues(schema)).toEqual([]);
    expect(() => assertDeployablePatterns('clean-form', schema)).not.toThrow();
  });

  test('aggregates direct and nested not pattern issues with actionable paths', () => {
    const schema = {
      properties: {
        code: {
          pattern: '\\p{L}',
          allOf: [{ not: { pattern: '[a-z' } }],
        },
      },
    };

    const issues = findSchemaPatternIssues(schema);

    expect(issues).toEqual([
      {
        path: '$.properties.code.pattern',
        pattern: '\\p{L}',
        reason: 'unsupported RE2 syntax',
      },
      {
        path: '$.properties.code.allOf[0].not.pattern',
        pattern: '[a-z',
        reason: 'unsupported RE2 syntax',
      },
    ]);
    expect(() => assertDeployablePatterns('nested-form', schema)).toThrow(
      'Form nested-form contains patterns that cannot be deployed:\n' +
        '- $.properties.code.pattern: unsupported RE2 syntax: \\p{L}\n' +
        '- $.properties.code.allOf[0].not.pattern: unsupported RE2 syntax: [a-z\n' +
        SAFE_SUBSET_HINT,
    );
  });

  test('escapes pattern line breaks without adding quotes', () => {
    expect(() =>
      assertDeployablePatterns('multiline-form', {
        pattern: 'first\r\nsecond\\p{L}',
      }),
    ).toThrow(
      'Form multiline-form contains patterns that cannot be deployed:\n' +
        '- $.pattern: unsupported RE2 syntax: first\\r\\nsecond\\p{L}',
    );
  });

  test('reports an unbalanced group as unsupported syntax', () => {
    expect(findSchemaPatternIssues({ pattern: '(' })).toEqual([
      {
        path: '$.pattern',
        pattern: '(',
        reason: 'unsupported RE2 syntax',
      },
    ]);
  });

  test('accepts ambiguous alternation the old safe subset refused', () => {
    const pattern = '^' + '(?:a|aa)'.repeat(30) + 'b$';

    expect(findSchemaPatternIssues({ pattern })).toEqual([]);
  });

  test('ignores non-string pattern values', () => {
    expect(
      findSchemaPatternIssues({
        pattern: 42,
        properties: { nested: { pattern: null } },
      }),
    ).toEqual([]);
  });

  test('stops at an object cycle', () => {
    const schema: Record<string, unknown> = { pattern: '\\p{L}' };
    schema.self = schema;

    expect(findSchemaPatternIssues(schema)).toEqual([
      {
        path: '$.pattern',
        pattern: '\\p{L}',
        reason: 'unsupported RE2 syntax',
      },
    ]);
  });

  test('stops at an array cycle', () => {
    const schema: unknown[] = [];
    schema.push(schema);

    expect(findSchemaPatternIssues(schema)).toEqual([]);
  });

  test('reports a shared unsafe schema object at every path', () => {
    const shared = { pattern: '\\p{L}' };
    const schema = { properties: { first: shared, second: shared } };

    expect(findSchemaPatternIssues(schema)).toEqual([
      {
        path: '$.properties.first.pattern',
        pattern: '\\p{L}',
        reason: 'unsupported RE2 syntax',
      },
      {
        path: '$.properties.second.pattern',
        pattern: '\\p{L}',
        reason: 'unsupported RE2 syntax',
      },
    ]);
  });

  test('does not mutate the schema', () => {
    const schema = {
      properties: {
        code: { pattern: '\\p{L}' },
      },
    };
    const before = structuredClone(schema);

    findSchemaPatternIssues(schema);

    expect(schema).toEqual(before);
  });
});

describe('findSchemaPatternIssues — issue #21 patterns are deployable', () => {
  test.each(['^\\d{3}-\\d{4}$', '^(yes|no)$', '[a-z]+@[a-z]+\\.[a-z]+', '\\d+'])(
    '%s produces no issue',
    (pattern) => {
      expect(findSchemaPatternIssues({ pattern })).toEqual([]);
    },
  );

  test('unsupported syntax is reported with its reason', () => {
    expect(findSchemaPatternIssues({ pattern: '\\p{L}+' })).toEqual([
      { path: '$.pattern', pattern: '\\p{L}+', reason: 'unsupported RE2 syntax' },
    ]);
  });

  test('an oversized expansion is reported with its reason', () => {
    expect(findSchemaPatternIssues({ pattern: '(?:a{1000}){1000}' })).toEqual([
      {
        path: '$.pattern',
        pattern: '(?:a{1000}){1000}',
        reason: 'pattern too large',
      },
    ]);
  });
});

/**
 * A drift guard for the two hand-maintained mirrors of `parser.ts`'s refusal
 * paths: `SAFE_SUBSET_HINT` above and ADR 0005's construct list. Both drifted
 * during development and were caught only by human inspection.
 *
 * This pins exactly one direction — the documentation claiming a refusal that
 * is not real, which is the direction that misleads a form author into
 * rewriting a pattern that would have compiled. The reverse direction, the
 * parser refusing something the docs never mention, is not mechanically
 * checkable from a prose list; ADR 0005 handles it honestly by naming
 * `src/lib/re2/parser.ts` as the authority rather than the prose.
 *
 * If a row here starts failing, the fix is a documentation edit, not a test
 * edit: either the parser gained support for the construct and both mirrors
 * should stop listing it, or the parser lost a refusal it should still have.
 */
describe('documented refusals — the constructs the docs name are really refused', () => {
  test.each([
    ['\\p{L}', 'Unicode property class'],
    ['(?i)abc', 'inline flags'],
    ['[[:alpha:]]', 'POSIX class'],
    ['(?P<x>a)', 'named group'],
    ['(?=x)', 'lookahead'],
    ['[\\S]', 'negated class escape inside a character class'],
    ['[]a]', 'class whose first member is ]'],
    ['[:abc]', 'class whose first member is :'],
    ['\\a', 'bell escape'],
    ['\\Aabc', 'text-start anchor'],
    ['abc\\z', 'text-end anchor'],
    ['\\Qa.b\\E', 'literal quoting'],
    ['\\x{41}', 'braced hex escape'],
    ['\\101', 'octal or backreference escape'],
    ['\\C', 'any-byte escape'],
    ['\\0', 'NUL escape'],
    ['a{1001}', "repeat count above RE2's maximum of 1000"],
    ['^*', 'quantified assertion'],
    ['(?:^)*', 'quantified group wrapping an assertion'],
  ])('%s (%s) is refused', (pattern) => {
    expect(compilePattern(pattern).ok).toBe(false);
  });
});

describe('assertDeployablePatterns — override', () => {
  const schema = { properties: { a: { pattern: '\\p{L}+' } } };

  test('throws without the allowance', () => {
    expect(() => assertDeployablePatterns('form1', schema)).toThrow(
      /unsupported RE2 syntax/,
    );
  });

  test('warns and proceeds with the allowance', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() =>
      assertDeployablePatterns('form1', schema, { allowUnevaluable: true }),
    ).not.toThrow();
    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain('form1');
    expect(message).toContain('\\p{L}+');
    expect(message).toContain('checked only by Google');
    warn.mockRestore();
  });

  test('stays silent with the allowance when there is nothing to report', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    assertDeployablePatterns('form1', { pattern: '^\\d{3}$' }, {
      allowUnevaluable: true,
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
