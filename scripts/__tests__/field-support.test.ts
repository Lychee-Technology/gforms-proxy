import { describe, test, expect } from 'vitest';
import { assertSupportedFieldTypes, UNSUPPORTED_TYPE_LABELS } from '../field-support.js';
import { QUESTION_TYPE_MAP, FLAG_DERIVED_TYPE_LABELS } from '../../src/lib/types.js';
import type { FieldDetail } from '../../src/lib/types.js';

const field = (label: string, typeCode: number, typeLabel: string): FieldDetail => ({
  label,
  typeCode,
  typeLabel,
  options: [],
  required: false,
  entryId: 'entry.111',
});

describe('assertSupportedFieldTypes', () => {
  test('passes silently for supported types', () => {
    expect(() =>
      assertSupportedFieldTypes('form123', [
        field('Name', 0, 'short_answer'),
        field('Choice', 2, 'multiple_choice'),
        field('Tags', 3, 'checkboxes'),
      ]),
    ).not.toThrow();
  });

  test.each([
    ['multiple_choice_grid', 7],
    ['checkbox_grid', 7],
    ['date', 9],
    ['date_time', 9],
    ['date_without_year', 9],
    ['time', 10],
    ['duration', 10],
  ])('throws for %s questions', (typeLabel, typeCode) => {
    expect(() =>
      assertSupportedFieldTypes('form123', [field('Bad question', typeCode, typeLabel)]),
    ).toThrow(/Bad question/);
  });

  test('lists every offending question with its type', () => {
    expect(() =>
      assertSupportedFieldTypes('form123', [
        field('Name', 0, 'short_answer'),
        field('Pick a date', 9, 'date'),
        field('Rate each item', 7, 'multiple_choice_grid'),
      ]),
    ).toThrow(/Pick a date.*date[\s\S]*Rate each item.*multiple_choice_grid/);
  });

  test('exports the unsupported label set', () => {
    expect([...UNSUPPORTED_TYPE_LABELS].sort()).toEqual([
      'checkbox_grid',
      'date',
      'date_time',
      'date_without_year',
      'duration',
      'multiple_choice_grid',
      'time',
    ]);
  });

  test('every unsupported label is one the parser can emit', () => {
    const knownLabels = new Set([
      ...Object.values(QUESTION_TYPE_MAP),
      ...Object.values(FLAG_DERIVED_TYPE_LABELS),
    ]);
    for (const label of UNSUPPORTED_TYPE_LABELS) {
      expect(knownLabels).toContain(label);
    }
  });
});
