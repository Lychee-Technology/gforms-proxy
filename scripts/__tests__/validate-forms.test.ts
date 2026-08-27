import { describe, expect, test } from 'vitest';
import packageJson from '../../package.json' with { type: 'json' };
import registry from '../../src/forms/registry.js';
import type { FormDefinition } from '../../src/lib/types.js';
import { validateRegisteredForms } from '../validate-forms.js';

const definitionWithSchema = (
  formId: string,
  schema: Record<string, unknown>,
): FormDefinition => ({
  formId,
  submissionUrl: `https://docs.google.com/forms/d/e/${formId}/formResponse`,
  schema,
  fieldMap: {},
});

describe('validateRegisteredForms', () => {
  test('accepts the production registry', () => {
    expect(() => validateRegisteredForms(registry)).not.toThrow();
  });

  test('aggregates every unsafe form with actionable pattern details', () => {
    const definitions = new Map<string, FormDefinition>([
      [
        'unsafe-form-one',
        definitionWithSchema('unsafe-form-one', {
          properties: { code: { pattern: '\\p{L}' } },
        }),
      ],
      [
        'unsafe-form-two',
        definitionWithSchema('unsafe-form-two', {
          properties: {
            answer: { allOf: [{ not: { pattern: '(a+)+' } }] },
          },
        }),
      ],
    ]);

    expect(() => validateRegisteredForms(definitions)).toThrow(
      'Registered form validation failed:\n' +
        'Form unsafe-form-one contains patterns that cannot be deployed:\n' +
        '- $.properties.code.pattern: outside safe RE2 subset: \\p{L}\n\n' +
        'Form unsafe-form-two contains patterns that cannot be deployed:\n' +
        '- $.properties.answer.allOf[0].not.pattern: outside safe RE2 subset: (a+)+',
    );
  });
});

test('deployment scripts validate forms before Wrangler runs', () => {
  // Inline && rather than a predeploy hook: pnpm only runs pre/post scripts
  // when enable-pre-post-scripts is on, so a hook can be silently skipped by
  // user-level config or a pnpm version with a different default.
  expect(packageJson.scripts.deploy).toBe(
    'pnpm validate:forms && wrangler deploy',
  );
  expect(packageJson.scripts).not.toHaveProperty('predeploy');
});
