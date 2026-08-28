import { describe, expect, test } from 'vitest';
import {
  SAFE_SUBSET_HINT,
  assertDeployablePatterns,
  findSchemaPatternIssues,
} from '../pattern-policy.js';

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
        reason: 'outside safe RE2 subset',
      },
      {
        path: '$.properties.code.allOf[0].not.pattern',
        pattern: '[a-z',
        reason: 'outside safe RE2 subset',
      },
    ]);
    expect(() => assertDeployablePatterns('nested-form', schema)).toThrow(
      'Form nested-form contains patterns that cannot be deployed:\n' +
        '- $.properties.code.pattern: outside safe RE2 subset: \\p{L}\n' +
        '- $.properties.code.allOf[0].not.pattern: outside safe RE2 subset: [a-z\n' +
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
        '- $.pattern: outside safe RE2 subset: first\\r\\nsecond\\p{L}',
    );
  });

  test('reports a translated pattern that JavaScript cannot compile', () => {
    expect(findSchemaPatternIssues({ pattern: '(' })).toEqual([
      {
        path: '$.pattern',
        pattern: '(',
        reason: 'uncompilable translated pattern',
      },
    ]);
  });

  test('reports ambiguous alternation as outside the safe subset', () => {
    const pattern = '^' + '(?:a|aa)'.repeat(30) + 'b$';

    expect(findSchemaPatternIssues({ pattern })).toEqual([
      {
        path: '$.pattern',
        pattern,
        reason: 'outside safe RE2 subset',
      },
    ]);
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
        reason: 'outside safe RE2 subset',
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
        reason: 'outside safe RE2 subset',
      },
      {
        path: '$.properties.second.pattern',
        pattern: '\\p{L}',
        reason: 'outside safe RE2 subset',
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
