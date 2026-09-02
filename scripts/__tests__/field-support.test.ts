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
  test('passes silently for every supported type, grids and dates included', () => {
    expect(() =>
      assertSupportedFieldTypes('form123', [
        field('Name', 0, 'short_answer'),
        field('Choice', 2, 'multiple_choice'),
        field('Industry', 3, 'dropdown'),
        field('Tags', 4, 'checkboxes'),
        field('Rate', 7, 'multiple_choice_grid'),
        field('Pick', 7, 'checkbox_grid'),
        field('When', 9, 'date'),
        field('At', 10, 'time'),
      ]),
    ).not.toThrow();
  });

  test.each([
    ['date_time', 9],
    ['date_without_year', 9],
    ['duration', 10],
  ])('throws for %s questions', (typeLabel, typeCode) => {
    expect(() =>
      assertSupportedFieldTypes('form123', [field('Bad question', typeCode, typeLabel)]),
    ).toThrow(/Bad question/);
  });

  test('lists every offending question with its variant', () => {
    expect(() =>
      assertSupportedFieldTypes('form123', [
        field('Name', 0, 'short_answer'),
        field('Pick a moment', 9, 'date_time'),
        field('How long', 10, 'duration'),
      ]),
    ).toThrow(/Pick a moment.*date_time[\s\S]*How long.*duration/);
  });

  test('exports the unsupported label set', () => {
    expect([...UNSUPPORTED_TYPE_LABELS].sort()).toEqual(['date_time', 'date_without_year', 'duration']);
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
