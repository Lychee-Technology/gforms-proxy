import type { FieldDetail } from '../src/lib/types.js';

/**
 * Question types the pipeline cannot submit correctly yet: the submitter
 * would serialize a grid object as "[object Object]"; a date answer needs
 * entry.X_year / entry.X_month / entry.X_day and a time answer needs
 * entry.X_hour / entry.X_minute, and the submitter sends neither set.
 * Refuse to generate a definition containing them instead of corrupting
 * data (#6).
 * The validator itself now checks grid entries (#18) and the date and time
 * formats (#17); submission is what still blocks all four (#23).
 *
 * Keep in sync with QUESTION_TYPE_MAP codes 6, 7, 9, 10 (src/lib/types.ts);
 * a test asserts every label here exists in that map.
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
      'remove them from the form or wait for support (issue #23).',
  );
}
