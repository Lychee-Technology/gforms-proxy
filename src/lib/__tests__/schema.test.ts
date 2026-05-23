import { describe, test, expect } from 'vitest';
import { buildJsonSchema, buildFieldMap } from '../schema.js';
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
    const schema = await buildJsonSchema(BASE_DATA, null);
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
  });

  test('sets required array from required fields only', async () => {
    const schema = await buildJsonSchema(BASE_DATA, null);
    expect(schema.required).toEqual(['field_1']);
  });

  test('generates fallback keys field_1, field_2 without Gemini', async () => {
    const schema = await buildJsonSchema(BASE_DATA, null);
    const props = schema.properties as Record<string, unknown>;
    expect(Object.keys(props)).toContain('field_1');
    expect(Object.keys(props)).toContain('field_2');
  });

  test('sets $id from formId', async () => {
    const schema = await buildJsonSchema(BASE_DATA, null);
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
    const schema = await buildJsonSchema(data, null);
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
    const schema = await buildJsonSchema(data, null);
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
    const schema = await buildJsonSchema(data, null);
    const prop = (schema.properties as any).field_1;
    expect(prop.format).toBe('email');
  });

  test('omits $id when formId is empty', async () => {
    const data: RawFormData = { ...BASE_DATA, formId: '' };
    const schema = await buildJsonSchema(data, null);
    expect(schema.$id).toBeUndefined();
  });

  test('omits required array when no fields are required', async () => {
    const data: RawFormData = {
      ...BASE_DATA,
      fields: BASE_DATA.fields.map((f) => ({ ...f, required: false })),
    };
    const schema = await buildJsonSchema(data, null);
    expect(schema.required).toBeUndefined();
  });

  test('property title is the question text, not entry ID', async () => {
    const schema = await buildJsonSchema(BASE_DATA, null);
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
