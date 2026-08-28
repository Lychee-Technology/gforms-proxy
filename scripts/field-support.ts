import type { FieldDetail } from '../src/lib/types.js';

/**
 * Question types the pipeline cannot submit correctly yet: the validator
 * never recurses into grid objects, the submitter would serialize them as
 * "[object Object]", and date/time need entry.X_year/_month/_day parameters
 * the submitter never sends. Refuse to generate a definition containing
 * them instead of corrupting data (#6).
 */
export const UNSUPPORTED_TYPE_LABELS: ReadonlySet<string> = new Set([
  'grid',
  'multiple_choice_grid',
  'date',
  'time',
]);

export function assertSupportedFieldTypes(formId: string, fields: FieldDetail[]): void {
  const offending = fields.filter((f) => UNSUPPORTED_TYPE_LABELS.has(f.typeLabel));
  if (offending.length === 0) return;

  const details = offending
    .map((f) => `- "${f.label}" (${f.typeLabel})`)
    .join('\n');
  throw new Error(
    `Form ${formId} contains question types that are not supported yet:\n${details}\n` +
      'Grid, date, and time questions cannot be submitted correctly; ' +
      'remove them from the form or wait for support (issue #6).',
  );
}
