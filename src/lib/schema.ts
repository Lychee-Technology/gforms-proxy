import { GoogleGenAI } from '@google/genai';
import type {
  FieldMeta,
  FieldSchemaDetail,
  FormMeta,
  JsonSchemaProperty,
  RawFormData,
} from './types.js';

const GEMINI_MODEL = 'gemini-2.0-flash';

// --- Pure helpers ---

const normalizeKey = (value: string, fallbackLabel: string): string => {
  const try1 = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  if (try1) return try1;
  const try2 = fallbackLabel
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return try2 || 'field';
};

const parseGeminiText = <T>(text: string): T => {
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned) as T;
};

const asNumber = (value: string): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const getNumericRange = (options: string[]) => {
  const numbers = options.map(asNumber).filter((n): n is number => n !== null);
  if (!numbers.length) return null;
  return { min: Math.min(...numbers), max: Math.max(...numbers) };
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const addPattern = (schema: JsonSchemaProperty, pattern: string) => {
  if (!pattern) return;
  if (schema.pattern) {
    const existingAllOf = Array.isArray(schema.allOf) ? schema.allOf : [];
    const existingPattern = schema.pattern;
    delete schema.pattern;
    schema.allOf = [...existingAllOf, { pattern: existingPattern }, { pattern }];
    return;
  }
  if (Array.isArray(schema.allOf)) {
    (schema.allOf as unknown[]).push({ pattern });
    return;
  }
  schema.pattern = pattern;
};

const addNotConstraint = (schema: JsonSchemaProperty, constraint: Record<string, unknown>) => {
  const existingAllOf = Array.isArray(schema.allOf) ? schema.allOf : [];
  schema.allOf = [...existingAllOf, { not: constraint }];
};

const applyValidationToSchema = (
  property: JsonSchemaProperty,
  field: FieldSchemaDetail,
): JsonSchemaProperty => {
  const { validation } = field;
  if (!validation) return property;

  const schema = { ...property };
  const isTypeArray = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === 'string');
  const typeList = isTypeArray(schema.type)
    ? schema.type
    : schema.type
      ? [schema.type as string]
      : [];
  const canApplyNumber =
    !schema.type || typeList.some((t) => ['string', 'number', 'integer'].includes(t));
  const canApplyString = !schema.type || typeList.some((t) => t === 'string');

  const setMin = (key: 'minimum' | 'exclusiveMinimum', value: number) => {
    const current = typeof schema[key] === 'number' ? (schema[key] as number) : null;
    if (current === null || value > current) schema[key] = value;
  };
  const setMax = (key: 'maximum' | 'exclusiveMaximum', value: number) => {
    const current = typeof schema[key] === 'number' ? (schema[key] as number) : null;
    if (current === null || value < current) schema[key] = value;
  };
  const ensureStringType = () => {
    if (!schema.type) schema.type = 'string';
  };

  switch (validation.type) {
    case 'number': {
      if (!canApplyNumber) return property;
      const values = validation.values.map(asNumber);
      const first = values[0] ?? null;
      const second = values[1] ?? null;
      const primary = first ?? 0;
      schema.type = validation.operator === 'is_whole_number' ? 'integer' : 'number';
      switch (validation.operator) {
        case '>': setMin('exclusiveMinimum', primary); break;
        case '>=': setMin('minimum', primary); break;
        case '<': setMax('exclusiveMaximum', primary); break;
        case '<=': setMax('maximum', primary); break;
        case '=': schema.const = primary; break;
        case '!=': addNotConstraint(schema, { const: primary }); break;
        case 'between':
          if (first !== null) setMin('minimum', first);
          if (second !== null) setMax('maximum', second);
          break;
        case 'not_between':
          if (first !== null && second !== null) {
            addNotConstraint(schema, {
              minimum: Math.min(first, second),
              maximum: Math.max(first, second),
            });
          }
          break;
      }
      break;
    }
    case 'length': {
      if (!canApplyString) return property;
      ensureStringType();
      const target = asNumber(validation.values[0] ?? '');
      if (target === null) break;
      if (validation.operator === 'min') {
        const cur = typeof schema.minLength === 'number' ? schema.minLength : null;
        if (cur === null || target > cur) schema.minLength = target;
      } else if (validation.operator === 'max') {
        const cur = typeof schema.maxLength === 'number' ? schema.maxLength : null;
        if (cur === null || target < cur) schema.maxLength = target;
      }
      break;
    }
    case 'text': {
      if (!canApplyString) return property;
      ensureStringType();
      switch (validation.operator) {
        case 'email': schema.format = 'email'; break;
        case 'url': schema.format = 'uri'; break;
        case 'contains': {
          const v = validation.values[0];
          if (v) addPattern(schema, `.*${escapeRegExp(v)}.*`);
          break;
        }
        case 'does_not_contain': {
          const v = validation.values[0];
          if (v) addNotConstraint(schema, { pattern: `.*${escapeRegExp(v)}.*` });
          break;
        }
      }
      break;
    }
    case 'regular_expression': {
      if (!canApplyString) return property;
      ensureStringType();
      const raw = validation.values[0];
      if (!raw) break;
      if (validation.operator === 'matches' || validation.operator === 'contains') {
        addPattern(schema, raw);
      } else if (
        validation.operator === 'does_not_match' ||
        validation.operator === 'does_not_contain'
      ) {
        addNotConstraint(schema, { pattern: raw });
      }
      break;
    }
  }
  return schema;
};

const buildFieldPropertySchema = (field: FieldSchemaDetail): JsonSchemaProperty => {
  const base: JsonSchemaProperty = { title: field.entry_id, description: field.question };
  const hasOptions = field.options.length > 0;

  switch (field.type) {
    case 'multiple_choice':
    case 'dropdown':
      return applyValidationToSchema(
        {
          ...base,
          type: 'string',
          ...(field.required ? { minLength: 1 } : {}),
          ...(hasOptions ? { enum: field.options } : {}),
        },
        field,
      );
    case 'checkboxes':
      return applyValidationToSchema(
        {
          ...base,
          type: 'array',
          items: { type: 'string', ...(hasOptions ? { enum: field.options } : {}) },
          uniqueItems: true,
          ...(field.required ? { minItems: 1 } : {}),
        },
        field,
      );
    case 'linear_scale': {
      const range = getNumericRange(field.options);
      return applyValidationToSchema(
        { ...base, type: 'integer', ...(range ? { minimum: range.min, maximum: range.max } : {}) },
        field,
      );
    }
    case 'date':
      return applyValidationToSchema({ ...base, type: 'string', format: 'date' }, field);
    case 'time':
      return applyValidationToSchema({ ...base, type: 'string', format: 'time' }, field);
    case 'multiple_choice_grid':
    case 'grid':
      return applyValidationToSchema(
        {
          ...base,
          type: 'object',
          additionalProperties: { type: 'string', ...(hasOptions ? { enum: field.options } : {}) },
        },
        field,
      );
    default: {
      const property: JsonSchemaProperty = { ...base, type: 'string' };
      if (field.required) property.minLength = 1;
      if (hasOptions) property.enum = field.options;
      return applyValidationToSchema(property, field);
    }
  }
};

const buildGeminiPrompt = (questions: string[]) =>
  [
    'You are generating concise metadata for Google Forms questions.',
    'Return ONLY a JSON array; each element corresponds to the matching input question in order.',
    'Each element must have "title", "key", and "translated".',
    'title: concise English (<= 6 words), human-readable summary.',
    'key: snake_case, ASCII letters/numbers/underscores only, 3-30 chars, derived from meaning.',
    'translated: a faithful English translation of the original question (not shortened).',
    'No explanations or extra fields.',
    'Questions:',
    ...questions.map((q, idx) => `${idx + 1}. ${q}`),
  ].join('\n');

export async function buildFieldsMeta(
  questions: string[],
  geminiApiKey: string | null,
): Promise<FieldMeta[]> {
  const fallback = questions.map((q, idx) => ({
    title: q,
    key: `field_${idx + 1}`,
    translated: q,
  }));

  if (!geminiApiKey || !questions.length) return fallback;

  try {
    const client = new GoogleGenAI({ apiKey: geminiApiKey });
    const result = await client.models.generateContent({
      model: GEMINI_MODEL,
      contents: [{ role: 'user', parts: [{ text: buildGeminiPrompt(questions) }] }],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Concise, <=6 word English summary.' },
              key: { type: 'string', description: 'snake_case, 3-30 chars.' },
              translated: { type: 'string', description: 'Faithful English translation.' },
            },
            required: ['title', 'key', 'translated'],
          },
        },
      },
    });

    const text = result?.text;
    if (!text) throw new Error('Empty Gemini response');

    const parsed = parseGeminiText<Array<Record<string, unknown>>>(text);
    return questions.map((q, idx) => {
      const item = parsed[idx] ?? {};
      const title =
        typeof item['title'] === 'string' && item['title'].trim() ? item['title'].trim() : q;
      const key = normalizeKey(typeof item['key'] === 'string' ? item['key'] : title, q);
      const translated =
        typeof item['translated'] === 'string' && item['translated'].trim()
          ? item['translated'].trim()
          : q;
      return { title, key, translated };
    });
  } catch {
    return fallback;
  }
}

export async function buildFormMeta(
  title: string,
  geminiApiKey: string | null,
): Promise<FormMeta> {
  if (!geminiApiKey) return { translated: title };

  try {
    const client = new GoogleGenAI({ apiKey: geminiApiKey });
    const result = await client.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: [
                'Translate the following Google Form title into clear English.',
                'Return JSON with a single property "translated".',
                'No explanations.',
                `Title: ${title}`,
              ].join('\n'),
            },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: { translated: { type: 'string' } },
          required: ['translated'],
        },
      },
    });

    const text = result?.text;
    if (!text) throw new Error('Empty Gemini response');
    const parsed = parseGeminiText<Record<string, unknown>>(text);
    const translated =
      typeof parsed['translated'] === 'string' && parsed['translated'].trim()
        ? parsed['translated'].trim()
        : title;
    return { translated };
  } catch {
    return { translated: title };
  }
}

export async function buildJsonSchema(
  rawData: RawFormData,
  geminiApiKey: string | null,
): Promise<Record<string, unknown>> {
  const metas = await buildFieldsMeta(
    rawData.fields.map((f) => f.label),
    geminiApiKey,
  );

  const fieldDetails: FieldSchemaDetail[] = rawData.fields.map((field, idx) => {
    const meta = metas[idx] ?? {
      title: field.label,
      key: `field_${idx + 1}`,
      translated: field.label,
    };
    return {
      question: field.label,
      translated_question: meta.translated,
      key: meta.key,
      entry_id: field.entryId,
      type: field.typeLabel,
      type_code: field.typeCode ?? null,
      options: field.options,
      required: field.required,
      help_text: field.helpText ?? '',
      validation: field.validation ?? null,
    };
  });

  const formMeta = await buildFormMeta(rawData.formTitle, geminiApiKey);
  const properties: Record<string, JsonSchemaProperty> = {};
  for (const field of fieldDetails) {
    properties[field.key] = buildFieldPropertySchema(field);
  }

  const requiredKeys = fieldDetails.filter((f) => f.required).map((f) => f.key);
  const schema: Record<string, unknown> = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: formMeta.translated || rawData.formTitle,
    description: rawData.formTitle,
    type: 'object',
    additionalProperties: false,
    properties,
  };

  if (rawData.formId) {
    schema.$id = `https://docs.google.com/forms/d/e/${rawData.formId}/schema`;
  }
  if (requiredKeys.length) {
    schema.required = requiredKeys;
  }

  return schema;
}
