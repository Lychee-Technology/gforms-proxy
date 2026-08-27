import { describe, expect, test } from 'vitest';
import {
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
        '- $.properties.code.pattern: outside safe RE2 subset: "\\\\p{L}"\n' +
        '- $.properties.code.allOf[0].not.pattern: outside safe RE2 subset: "[a-z"',
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

  test('ignores non-string pattern values', () => {
    expect(
      findSchemaPatternIssues({
        pattern: 42,
        properties: { nested: { pattern: null } },
      }),
    ).toEqual([]);
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
