import { describe, test, expect } from 'vitest';
import { buildJsonSchema, buildFieldMap, buildFieldsMeta, resolveRowKeys } from '../schema.js';
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

  test('maps checkboxes with maxItems bounded by option count', async () => {
    const data: RawFormData = {
      ...BASE_DATA,
      fields: [
        {
          label: 'Toppings',
          entryId: 'entry.4',
          typeCode: 4,
          typeLabel: 'checkboxes',
          options: ['Cheese', 'Ham', 'Olives'],
          required: true,
          validation: null,
        },
      ],
    };
    const schema = buildJsonSchema(data);
    const prop = (schema.properties as any).field_1;
    expect(prop.type).toBe('array');
    expect(prop.maxItems).toBe(3);
    expect(prop.minItems).toBe(1);
  });

  test('checkboxes without options get no maxItems', async () => {
    const data: RawFormData = {
      ...BASE_DATA,
      fields: [
        {
          label: 'Anything',
          entryId: 'entry.5',
          typeCode: 4,
          typeLabel: 'checkboxes',
          options: [],
          required: false,
          validation: null,
        },
      ],
    };
    const schema = buildJsonSchema(data);
    const prop = (schema.properties as any).field_1;
    expect(prop.maxItems).toBeUndefined();
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

  // The anchoring above is what the published schema tells API consumers; it
  // is no longer what validate() enforces. Patterns are checked by Google
  // alone (ADR 0006), and a not-constraint carrying one must not invert into
  // a rejection.
  test('matches: validate() accepts both a partial and a full match', () => {
    const schema = buildJsonSchema({
      formTitle: 'T',
      formId: 'id',
      fields: [makeField({ type: 'regular_expression', operator: 'matches', values: ['[a-z]+\\d'] })],
    });
    expect(validate({ field_1: 'abc1x' }, schema as Record<string, unknown>)).toEqual([]);
    expect(validate({ field_1: 'abc1' }, schema as Record<string, unknown>)).toEqual([]);
  });

  test('does_not_match: validate() accepts a full match instead of rejecting everything', () => {
    const schema = buildJsonSchema({
      formTitle: 'T',
      formId: 'id',
      fields: [makeField({ type: 'regular_expression', operator: 'does_not_match', values: ['[a-z]+\\d'] })],
    });
    expect(validate({ field_1: 'abc1' }, schema as Record<string, unknown>)).toEqual([]);
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

  test('contains emits only the escaped literal, which validate() does not enforce', () => {
    const schema = build('contains');
    expect((schema.properties as any).field_1.pattern).toBe('a\\.b');
    expect(validate({ field_1: 'prefix a.b suffix' }, schema)).toEqual([]);
    expect(validate({ field_1: 'prefix acb suffix' }, schema)).toEqual([]);
  });

  test('does_not_contain emits the inverted literal, and validate() skips the not-constraint', () => {
    const schema = build('does_not_contain');
    expect((schema.properties as any).field_1.allOf).toEqual([
      { not: { pattern: 'a\\.b' } },
    ]);
    // Both values pass: the inner pattern is unevaluated, so inverting it
    // would reject every submission to this form.
    expect(validate({ field_1: 'prefix a.b suffix' }, schema)).toEqual([]);
    expect(validate({ field_1: 'prefix acb suffix' }, schema)).toEqual([]);
  });
});

const gridField = (overrides: Partial<FieldDetail> = {}): FieldDetail => ({
  label: 'Rate each item',
  typeCode: 7,
  typeLabel: 'multiple_choice_grid',
  options: ['Good', 'Bad'],
  required: true,
  entryId: 'entry.111',
  rows: [
    { label: 'Speed', entryId: 'entry.111' },
    { label: 'Price', entryId: 'entry.222' },
  ],
  ...overrides,
});

const rawWith = (...fields: FieldDetail[]): RawFormData => ({
  formTitle: 'T',
  formId: 'f',
  fields,
});

describe('grid, date and time schemas (#23)', () => {
  test('a multiple-choice grid names its rows and closes the object', () => {
    const schema = buildJsonSchema(rawWith(gridField())) as any;
    expect(schema.properties.field_1).toEqual({
      title: 'Rate each item',
      description: 'Rate each item',
      type: 'object',
      properties: {
        speed: { title: 'Speed', type: 'string', enum: ['Good', 'Bad'] },
        price: { title: 'Price', type: 'string', enum: ['Good', 'Bad'] },
      },
      required: ['speed', 'price'],
      additionalProperties: false,
    });
    expect(schema.required).toEqual(['field_1']);
  });

  test('an optional grid has no required rows', () => {
    const schema = buildJsonSchema(rawWith(gridField({ required: false }))) as any;
    expect(schema.properties.field_1.required).toBeUndefined();
    expect(schema.required).toBeUndefined();
  });

  test('a checkbox grid gives every row the checkboxes shape', () => {
    const schema = buildJsonSchema(rawWith(gridField({ typeLabel: 'checkbox_grid' }))) as any;
    expect(schema.properties.field_1.properties.speed).toEqual({
      title: 'Speed',
      type: 'array',
      items: { type: 'string', enum: ['Good', 'Bad'] },
      uniqueItems: true,
      minItems: 1,
      maxItems: 2,
    });
  });

  test('row keys dedupe within a grid and fall back positionally', () => {
    expect(
      resolveRowKeys([
        { label: 'Speed', entryId: 'entry.1' },
        { label: 'speed!', entryId: 'entry.2' },
        { label: '速度', entryId: 'entry.3' },
      ]),
    ).toEqual(['speed', 'speed_2', 'row_3']);
  });

  test('fieldMap carries a grid mapping whose row keys match the schema', () => {
    const raw = rawWith(gridField());
    const schema = buildJsonSchema(raw) as any;
    const fieldMap = buildFieldMap(raw.fields, buildFieldsMeta(['Rate each item']));
    expect(fieldMap.field_1).toEqual({
      kind: 'grid',
      rows: { speed: 'entry.111', price: 'entry.222' },
    });
    expect(Object.keys((fieldMap.field_1 as any).rows)).toEqual(
      Object.keys(schema.properties.field_1.properties),
    );
  });

  test('fieldMap carries date and time mappings and plain strings otherwise', () => {
    const fields: FieldDetail[] = [
      { label: 'When', typeCode: 9, typeLabel: 'date', options: [], required: false, entryId: 'entry.1' },
      { label: 'At', typeCode: 10, typeLabel: 'time', options: [], required: false, entryId: 'entry.2' },
      { label: 'Name', typeCode: 0, typeLabel: 'short_answer', options: [], required: false, entryId: 'entry.3' },
    ];
    expect(buildFieldMap(fields, buildFieldsMeta(['When', 'At', 'Name']))).toEqual({
      field_1: { kind: 'date', entryId: 'entry.1' },
      field_2: { kind: 'time', entryId: 'entry.2' },
      field_3: 'entry.3',
    });
  });

  test('the grid schema validates a well-formed answer and rejects an unknown row', () => {
    const schema = buildJsonSchema(rawWith(gridField()));
    expect(validate({ field_1: { speed: 'Good', price: 'Bad' } }, schema)).toEqual([]);
    expect(validate({ field_1: { speed: 'Good', price: 'Bad', extra: 'Good' } }, schema)).toEqual([
      { field: 'field_1.extra', message: 'additional property not allowed' },
    ]);
  });
});

describe('linear_scale and rating schemas (#43)', () => {
  const scaleField = (typeLabel: 'linear_scale' | 'rating', options: string[], required = false): FieldDetail => ({
    label: 'How was it?',
    typeCode: typeLabel === 'rating' ? 18 : 5,
    typeLabel,
    options,
    required,
    entryId: 'entry.1',
  });
  const rawWith = (field: FieldDetail): RawFormData => ({ ...BASE_DATA, fields: [field] });
  const propertyOf = (field: FieldDetail) =>
    (buildJsonSchema(rawWith(field)).properties as Record<string, Record<string, unknown>>).field_1!;

  test('a rating is an integer bounded by its scale', () => {
    const property = propertyOf(scaleField('rating', ['1', '2', '3', '4', '5']));
    expect(property.type).toBe('integer');
    expect(property.minimum).toBe(1);
    expect(property.maximum).toBe(5);
    expect(property.enum).toBeUndefined();
  });

  test('a linear scale is an integer bounded by its scale', () => {
    const property = propertyOf(scaleField('linear_scale', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']));
    expect(property.type).toBe('integer');
    expect(property.minimum).toBe(1);
    expect(property.maximum).toBe(10);
  });

  test('a rating with no numeric options is a bare integer', () => {
    const property = propertyOf(scaleField('rating', []));
    expect(property.type).toBe('integer');
    expect(property.minimum).toBeUndefined();
    expect(property.maximum).toBeUndefined();
    expect(property.minLength).toBeUndefined();
  });

  test('a required rating is listed in required, not given minLength', () => {
    const schema = buildJsonSchema(rawWith(scaleField('rating', ['1', '2', '3'], true)));
    expect(schema.required).toEqual(['field_1']);
    const property = (schema.properties as Record<string, Record<string, unknown>>).field_1!;
    expect(property.minLength).toBeUndefined();
  });

  test('the rating schema accepts an in-range integer and rejects a string or out-of-range value', () => {
    const schema = buildJsonSchema(rawWith(scaleField('rating', ['1', '2', '3', '4', '5'])));
    expect(validate({ field_1: 4 }, schema)).toEqual([]);
    expect(validate({ field_1: '4' }, schema)).not.toEqual([]);
    expect(validate({ field_1: 6 }, schema)).not.toEqual([]);
  });

  test('a rating maps to a plain entry ID in the fieldMap', () => {
    const field = scaleField('rating', ['1', '2', '3']);
    expect(buildFieldMap([field], buildFieldsMeta([field.label]))).toEqual({ field_1: 'entry.1' });
  });
});
