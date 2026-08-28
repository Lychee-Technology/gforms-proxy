import { describe, test, expect } from 'vitest';
import { assertSupportedFieldTypes, UNSUPPORTED_TYPE_LABELS } from '../field-support.js';
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
    ['grid', 6],
    ['multiple_choice_grid', 7],
    ['date', 9],
    ['time', 10],
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
      'date',
      'grid',
      'multiple_choice_grid',
      'time',
    ]);
  });
});
