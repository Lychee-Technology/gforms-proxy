import type { FieldDetail } from '../src/lib/types.js';

/**
 * Question variants the schema vocabulary cannot express (ADR 0008): a date
 * that includes a time (`format: date` has no time component), a date without
 * a year (`YYYY-MM-DD` has nowhere to omit it), and a duration (`format: time`
 * is `HH:MM`, ADR 0002). Refuse to generate a definition containing them
 * rather than publish a schema whose values the submitter would truncate.
 *
 * Grid, date and time questions themselves are supported end-to-end (#23).
 *
 * Keep in sync with FLAG_DERIVED_TYPE_LABELS (src/lib/types.ts); a test
 * asserts every label here is one the parser emits.
 */
export const UNSUPPORTED_TYPE_LABELS: ReadonlySet<string> = new Set([
  'date_time',
  'date_without_year',
  'duration',
]);

export function assertSupportedFieldTypes(formId: string, fields: FieldDetail[]): void {
  const offending = fields.filter((f) => UNSUPPORTED_TYPE_LABELS.has(f.typeLabel));
  if (offending.length === 0) return;

  const details = offending
    .map((f) => `- "${f.label}" (${f.typeLabel})`)
    .join('\n');
  throw new Error(
    `Form ${formId} contains question variants that are not supported yet:\n${details}\n` +
      'A date that includes a time, a date without a year, and a duration have no ' +
      'JSON Schema format in this proxy (ADR 0008). Turn the option off in Google Forms ' +
      'or wait for support.',
  );
}
