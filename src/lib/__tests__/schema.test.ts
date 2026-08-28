import { describe, test, expect } from 'vitest';
import { buildJsonSchema, buildFieldMap } from '../schema.js';
import { validate } from '../validator.js';
import type { RawFormData, FieldDetail, FieldMeta } from '../types.js';

const BASE_DATA: RawFormData = {
  formTitle: 'Test Form',
  formId: 'abc123',
  fields: [
    {
      label: 'Full Name',
      entryId: 'entry.1',
      typeCode: 0,
      typeLabel: 'short_answer',
      options: [],
      required: true,
      validation: null,
    },
    {
      label: 'Notes',
      entryId: 'entry.2',
      typeCode: 1,
      typeLabel: 'paragraph',
      options: [],
      required: false,
      validation: null,
    },
  ],
};

describe('buildJsonSchema (no Gemini)', () => {
  test('generates $schema and type:object', async () => {
    const schema = buildJsonSchema(BASE_DATA);
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
  });

  test('sets required array from required fields only', async () => {
    const schema = buildJsonSchema(BASE_DATA);
    expect(schema.required).toEqual(['field_1']);
  });

  test('generates fallback keys field_1, field_2 without Gemini', async () => {
    const schema = buildJsonSchema(BASE_DATA);
    const props = schema.properties as Record<string, unknown>;
    expect(Object.keys(props)).toContain('field_1');
    expect(Object.keys(props)).toContain('field_2');
  });

  test('sets $id from formId', async () => {
    const schema = buildJsonSchema(BASE_DATA);
    expect(schema.$id).toBe('https://docs.google.com/forms/d/e/abc123/schema');
  });

  test('maps multiple_choice with enum options', async () => {
    const data: RawFormData = {
      ...BASE_DATA,
      fields: [
        {
          label: 'Color',
          entryId: 'entry.3',
          typeCode: 2,
          typeLabel: 'multiple_choice',
          options: ['Red', 'Green', 'Blue'],
          required: false,
          validation: null,
        },
      ],
    };
    const schema = buildJsonSchema(data);
    const prop = (schema.properties as any).field_1;
    expect(prop.type).toBe('string');
    expect(prop.enum).toEqual(['Red', 'Green', 'Blue']);
  });

  test('applies number validation >= to schema', async () => {
    const data: RawFormData = {
      ...BASE_DATA,
      fields: [
        {
          label: 'Age',
          entryId: 'entry.4',
          typeCode: 0,
          typeLabel: 'short_answer',
          options: [],
          required: false,
          validation: { type: 'number', operator: '>=', values: ['18'] },
        },
      ],
    };
    const schema = buildJsonSchema(data);
    const prop = (schema.properties as any).field_1;
    expect(prop.minimum).toBe(18);
  });

  test('applies email text validation', async () => {
    const data: RawFormData = {
      ...BASE_DATA,
      fields: [
        {
          label: 'Email',
          entryId: 'entry.5',
          typeCode: 0,
          typeLabel: 'short_answer',
          options: [],
          required: true,
          validation: { type: 'text', operator: 'email', values: [] },
        },
      ],
    };
    const schema = buildJsonSchema(data);
    const prop = (schema.properties as any).field_1;
    expect(prop.format).toBe('email');
  });

  test('omits $id when formId is empty', async () => {
    const data: RawFormData = { ...BASE_DATA, formId: '' };
    const schema = buildJsonSchema(data);
    expect(schema.$id).toBeUndefined();
  });

  test('omits required array when no fields are required', async () => {
    const data: RawFormData = {
      ...BASE_DATA,
      fields: BASE_DATA.fields.map((f) => ({ ...f, required: false })),
    };
    const schema = buildJsonSchema(data);
    expect(schema.required).toBeUndefined();
  });

  test('property title is the question text, not entry ID', async () => {
    const schema = buildJsonSchema(BASE_DATA);
    const props = schema.properties as Record<string, { title: string }>;
    expect(props['field_1']?.title).toBe('Full Name');
  });
});

describe('buildFieldMap', () => {
  const fields: FieldDetail[] = [
    { label: 'Full Name', entryId: 'entry.111', typeCode: 0, typeLabel: 'short_answer', options: [], required: true, validation: null },
    { label: 'Email', entryId: 'entry.222', typeCode: 0, typeLabel: 'short_answer', options: [], required: false, validation: null },
  ];
  const metas: FieldMeta[] = [
    { title: 'Full Name', key: 'full_name', translated: 'Full Name' },
    { title: 'Email', key: 'email', translated: 'Email' },
  ];

  test('maps schema keys to entry IDs', () => {
    const result = buildFieldMap(fields, metas);
    expect(result).toEqual({ full_name: 'entry.111', email: 'entry.222' });
  });

  test('falls back to field_N key when meta missing', () => {
    const result = buildFieldMap(fields, []);
    expect(result).toEqual({ field_1: 'entry.111', field_2: 'entry.222' });
  });
});

describe('key deduplication', () => {
  const makeField = (label: string, entryId: string, required = false): FieldDetail => ({
    label,
    entryId,
    typeCode: 0,
    typeLabel: 'short_answer',
    options: [],
    required,
    validation: null,
  });
  const makeMeta = (key: string, title = key): FieldMeta => ({ title, key, translated: title });

  const dupFields = [
    makeField('Is status recorded?', 'entry.1'),
    makeField('Is status recorded?', 'entry.2', true),
  ];
  const dupMetas = [makeMeta('status_recorded'), makeMeta('status_recorded')];

  test('colliding keys get distinct suffixed keys in schema properties', () => {
    const schema = buildJsonSchema(
      { formTitle: 'T', formId: 'id', fields: dupFields },
      dupMetas,
    );
    const props = schema.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(['status_recorded', 'status_recorded_2']);
  });

  test('fieldMap uses the same deduplicated keys as the schema', () => {
    const fieldMap = buildFieldMap(dupFields, dupMetas);
    expect(fieldMap).toEqual({
      status_recorded: 'entry.1',
      status_recorded_2: 'entry.2',
    });
  });

  test('required array uses deduplicated keys', () => {
    const schema = buildJsonSchema(
      { formTitle: 'T', formId: 'id', fields: dupFields },
      dupMetas,
    );
    expect(schema.required).toEqual(['status_recorded_2']);
  });

  test('a generated key equal to turnstile_token is renamed', () => {
    const fields = [makeField('Token?', 'entry.9')];
    const metas = [makeMeta('turnstile_token')];
    const schema = buildJsonSchema({ formTitle: 'T', formId: 'id', fields }, metas);
    const props = schema.properties as Record<string, unknown>;
    expect(props['turnstile_token']).toBeUndefined();
    expect(props['turnstile_token_2']).toBeDefined();
    expect(buildFieldMap(fields, metas)).toEqual({ turnstile_token_2: 'entry.9' });
  });

  test('collision with an already-suffixed key still yields distinct keys', () => {
    const fields = [
      makeField('A', 'entry.1'),
      makeField('B', 'entry.2'),
      makeField('C', 'entry.3'),
    ];
    const metas = [makeMeta('contact'), makeMeta('contact'), makeMeta('contact_2')];
    const fieldMap = buildFieldMap(fields, metas);
    expect(fieldMap).toEqual({
      contact: 'entry.1',
      contact_2: 'entry.2',
      contact_2_2: 'entry.3',
    });
    const schema = buildJsonSchema({ formTitle: 'T', formId: 'id', fields }, metas);
    expect(Object.keys(schema.properties as Record<string, unknown>)).toEqual(
      Object.keys(fieldMap),
    );
  });

  test('duplicate fallback keys from missing metas stay distinct', () => {
    const fields = [makeField('A', 'entry.1'), makeField('B', 'entry.2')];
    const metas = [makeMeta('field_2')];
    const fieldMap = buildFieldMap(fields, metas);
    const schema = buildJsonSchema({ formTitle: 'T', formId: 'id', fields }, metas);
    expect(Object.keys(fieldMap)).toHaveLength(2);
    expect(Object.keys(schema.properties as Record<string, unknown>)).toEqual(
      Object.keys(fieldMap),
    );
  });
});

describe('regular_expression validation anchoring', () => {
  const makeField = (validation: FieldDetail['validation']): FieldDetail => ({
    label: 'Code',
    entryId: 'entry.7',
    typeCode: 0,
    typeLabel: 'short_answer',
    options: [],
    required: false,
    validation,
  });

  const build = (validation: FieldDetail['validation']) => {
    const schema = buildJsonSchema({ formTitle: 'T', formId: 'id', fields: [makeField(validation)] });
    return (schema.properties as any).field_1;
  };

  test('matches emits an anchored full-match pattern', () => {
    const prop = build({ type: 'regular_expression', operator: 'matches', values: ['[a-z]+\\d'] });
    expect(prop.pattern).toBe('^(?:[a-z]+\\d)$');
  });

  test('does_not_match emits an anchored not-constraint pattern', () => {
    const prop = build({ type: 'regular_expression', operator: 'does_not_match', values: ['[a-z]+\\d'] });
    expect(prop.allOf).toEqual([{ not: { pattern: '^(?:[a-z]+\\d)$' } }]);
  });

  test('regex contains stays unanchored', () => {
    const prop = build({ type: 'regular_expression', operator: 'contains', values: ['[a-z]+\\d'] });
    expect(prop.pattern).toBe('[a-z]+\\d');
  });

  test('regex does_not_contain stays unanchored', () => {
    const prop = build({ type: 'regular_expression', operator: 'does_not_contain', values: ['[a-z]+\\d'] });
    expect(prop.allOf).toEqual([{ not: { pattern: '[a-z]+\\d' } }]);
  });

  test('matches: a partial match fails validate() while a full match passes', () => {
    const schema = buildJsonSchema({
      formTitle: 'T',
      formId: 'id',
      fields: [makeField({ type: 'regular_expression', operator: 'matches', values: ['[a-z]+\\d'] })],
    });
    expect(validate({ field_1: 'abc1x' }, schema as Record<string, unknown>)).toHaveLength(1);
    expect(validate({ field_1: 'abc1' }, schema as Record<string, unknown>)).toEqual([]);
  });

  test('does_not_match: only a full match fails validate(), a partial match passes', () => {
    const schema = buildJsonSchema({
      formTitle: 'T',
      formId: 'id',
      fields: [makeField({ type: 'regular_expression', operator: 'does_not_match', values: ['[a-z]+\\d'] })],
    });
    expect(validate({ field_1: 'abc1' }, schema as Record<string, unknown>)).toHaveLength(1);
    expect(validate({ field_1: 'abc1x' }, schema as Record<string, unknown>)).toEqual([]);
  });
});

describe('text contains validation', () => {
  const build = (operator: 'contains' | 'does_not_contain') => {
    const field: FieldDetail = {
      label: 'Code',
      entryId: 'entry.8',
      typeCode: 0,
      typeLabel: 'short_answer',
      options: [],
      required: false,
      validation: { type: 'text', operator, values: ['a.b'] },
    };
    return buildJsonSchema({ formTitle: 'T', formId: 'id', fields: [field] });
  };

  test('contains emits only the escaped literal and validates by partial match', () => {
    const schema = build('contains');
    expect((schema.properties as any).field_1.pattern).toBe('a\\.b');
    expect(validate({ field_1: 'prefix a.b suffix' }, schema)).toEqual([]);
    expect(validate({ field_1: 'prefix acb suffix' }, schema)).toHaveLength(1);
  });

  test('does_not_contain inverts only the escaped literal partial match', () => {
    const schema = build('does_not_contain');
    expect((schema.properties as any).field_1.allOf).toEqual([
      { not: { pattern: 'a\\.b' } },
    ]);
    expect(validate({ field_1: 'prefix a.b suffix' }, schema)).toHaveLength(1);
    expect(validate({ field_1: 'prefix acb suffix' }, schema)).toEqual([]);
  });
});
