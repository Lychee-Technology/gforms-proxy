# Form Submission Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `POST /api/v1/forms/:formId/responses` to the Worker (validate + submit to Google Forms) and update the CLI to optionally emit a `FormDefinition` file.

**Architecture:** Static `FormDefinition` JSON files bundled at deploy time; Worker validates request body against bundled JSON Schema then POSTs `application/x-www-form-urlencoded` to Google Forms. CLI rewritten from scratch to use `src/lib/` modules with `--url`/`--out`/`--gemini-key` flags.

**Tech Stack:** Hono, Vitest (TDD), Cloudflare Workers, wrangler, tsx (CLI runner)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/lib/types.ts` | Modify | Add `FormDefinition` interface |
| `src/lib/schema.ts` | Modify | Add `buildFieldMap()`, fix `title`, add `prebuiltMetas` param |
| `src/lib/__tests__/schema.test.ts` | Modify | Add `buildFieldMap` tests, fix `title` assertion |
| `src/lib/validator.ts` | Create | Purpose-built JSON Schema validator |
| `src/lib/__tests__/validator.test.ts` | Create | Validator unit tests |
| `src/lib/submitter.ts` | Create | Google Forms `application/x-www-form-urlencoded` submitter |
| `src/lib/__tests__/submitter.test.ts` | Create | Submitter unit tests |
| `src/forms/registry.ts` | Create | Static Map of `FormDefinition` objects |
| `src/index.ts` | Modify | Add `POST /api/v1/forms/:formId/responses` route |
| `scripts/gen-field-mapping.ts` | Rewrite | CLI using `src/lib/` modules, `--url`/`--out`/`--gemini-key` flags |

---

## Task 1: Add FormDefinition to types.ts

**Files:**
- Modify: `src/lib/types.ts`

- [ ] **Step 1: Add the interface**

In `src/lib/types.ts`, append after the existing `RawFormData` interface (after line 48):

```typescript
export interface FormDefinition {
  formId: string;
  submissionUrl: string;
  schema: Record<string, unknown>;
  fieldMap: Record<string, string>;  // schemaKey → "entry.XXXXXXX"
}
```

- [ ] **Step 2: Verify type-check**

```bash
cd /Users/ruoshi/code/github/gforms-proxy && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat: add FormDefinition interface to types"
```

---

## Task 2: Update schema.ts — buildFieldMap, title fix, prebuiltMetas

**Files:**
- Modify: `src/lib/schema.ts`
- Modify: `src/lib/__tests__/schema.test.ts`

- [ ] **Step 1: Write failing tests for buildFieldMap**

Add to the end of `src/lib/__tests__/schema.test.ts` (before the final `}`):

```typescript
import { buildFieldMap } from '../schema.js';
import type { FieldDetail, FieldMeta } from '../types.js';

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
```

Also add a test that `title` is the question text (not entry ID) — insert into the existing `describe('buildJsonSchema (no Gemini)')` block:

```typescript
  test('property title is the question text, not entry ID', async () => {
    const schema = await buildJsonSchema(BASE_DATA, null);
    const props = schema.properties as Record<string, { title: string }>;
    expect(props['field_1']?.title).toBe('Full Name');
  });
```

- [ ] **Step 2: Run tests — confirm failures**

```bash
cd /Users/ruoshi/code/github/gforms-proxy && pnpm test 2>&1 | tail -20
```

Expected: failures for `buildFieldMap` (not exported) and `title` test (currently returns entry ID).

- [ ] **Step 3: Export buildFieldMap from schema.ts**

Add this function to `src/lib/schema.ts` before `buildJsonSchema` (import `FieldDetail` from `./types.js` is already imported):

```typescript
export function buildFieldMap(
  fields: FieldDetail[],
  metas: FieldMeta[],
): Record<string, string> {
  const map: Record<string, string> = {};
  fields.forEach((field, idx) => {
    const key = metas[idx]?.key ?? `field_${idx + 1}`;
    map[key] = field.entryId;
  });
  return map;
}
```

Also add `FieldDetail` to the import at the top of `schema.ts` if not already there:
```typescript
import type {
  FieldDetail,
  FieldMeta,
  FieldSchemaDetail,
  FormMeta,
  JsonSchemaProperty,
  RawFormData,
} from './types.js';
```

- [ ] **Step 4: Fix title in buildFieldPropertySchema**

In `src/lib/schema.ts`, find line 182:
```typescript
const base: JsonSchemaProperty = { title: field.entry_id, description: field.question };
```
Change to:
```typescript
const base: JsonSchemaProperty = { title: field.question, description: field.question };
```

- [ ] **Step 5: Add prebuiltMetas param to buildJsonSchema**

Change the signature and the metas line in `buildJsonSchema`:

```typescript
export async function buildJsonSchema(
  rawData: RawFormData,
  geminiApiKey: string | null,
  prebuiltMetas?: FieldMeta[],
): Promise<Record<string, unknown>> {
  const metas = prebuiltMetas ?? await buildFieldsMeta(
    rawData.fields.map((f) => f.label),
    geminiApiKey,
  );
  // rest of function unchanged
```

- [ ] **Step 6: Run tests — confirm all pass**

```bash
cd /Users/ruoshi/code/github/gforms-proxy && pnpm test 2>&1 | tail -20
```

Expected: all tests pass (including new buildFieldMap and title tests).

- [ ] **Step 7: Commit**

```bash
git add src/lib/schema.ts src/lib/__tests__/schema.test.ts
git commit -m "feat: add buildFieldMap, fix title to question text, add prebuiltMetas param"
```

---

## Task 3: Create validator.ts (TDD)

**Files:**
- Create: `src/lib/__tests__/validator.test.ts`
- Create: `src/lib/validator.ts`

- [ ] **Step 1: Write failing tests**

Create `src/lib/__tests__/validator.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import { validate } from '../validator.js';

describe('validate — required fields', () => {
  const schema = {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string' },
      age: { type: 'integer' },
    },
    additionalProperties: false,
  };

  test('passes when required field is present', () => {
    expect(validate({ name: 'Alice' }, schema)).toEqual([]);
  });

  test('fails when required field is missing', () => {
    const errors = validate({}, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe('name');
  });

  test('fails for additional properties when additionalProperties=false', () => {
    const errors = validate({ name: 'Alice', extra: 'bad' }, schema);
    expect(errors.some((e) => e.field === 'extra')).toBe(true);
  });
});

describe('validate — type checking', () => {
  test('fails when string given for integer field', () => {
    const schema = { type: 'object', properties: { age: { type: 'integer' } } };
    const errors = validate({ age: 'not a number' }, schema);
    expect(errors.some((e) => e.field === 'age')).toBe(true);
  });

  test('fails when number is not an integer', () => {
    const schema = { type: 'object', properties: { age: { type: 'integer' } } };
    const errors = validate({ age: 1.5 }, schema);
    expect(errors.some((e) => e.field === 'age')).toBe(true);
  });

  test('passes for number type with float', () => {
    const schema = { type: 'object', properties: { score: { type: 'number' } } };
    expect(validate({ score: 3.14 }, schema)).toEqual([]);
  });

  test('fails when array given for string field', () => {
    const schema = { type: 'object', properties: { name: { type: 'string' } } };
    const errors = validate({ name: ['a'] }, schema);
    expect(errors.some((e) => e.field === 'name')).toBe(true);
  });

  test('passes array type', () => {
    const schema = { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } };
    expect(validate({ tags: ['a', 'b'] }, schema)).toEqual([]);
  });
});

describe('validate — string constraints', () => {
  test('fails minLength', () => {
    const schema = { type: 'object', properties: { name: { type: 'string', minLength: 3 } } };
    const errors = validate({ name: 'ab' }, schema);
    expect(errors.some((e) => e.field === 'name')).toBe(true);
  });

  test('passes minLength', () => {
    const schema = { type: 'object', properties: { name: { type: 'string', minLength: 3 } } };
    expect(validate({ name: 'abc' }, schema)).toEqual([]);
  });

  test('fails maxLength', () => {
    const schema = { type: 'object', properties: { name: { type: 'string', maxLength: 3 } } };
    const errors = validate({ name: 'abcd' }, schema);
    expect(errors.some((e) => e.field === 'name')).toBe(true);
  });

  test('fails email format', () => {
    const schema = { type: 'object', properties: { email: { type: 'string', format: 'email' } } };
    const errors = validate({ email: 'not-an-email' }, schema);
    expect(errors.some((e) => e.field === 'email')).toBe(true);
  });

  test('passes email format', () => {
    const schema = { type: 'object', properties: { email: { type: 'string', format: 'email' } } };
    expect(validate({ email: 'user@example.com' }, schema)).toEqual([]);
  });

  test('fails uri format', () => {
    const schema = { type: 'object', properties: { url: { type: 'string', format: 'uri' } } };
    const errors = validate({ url: 'not a url' }, schema);
    expect(errors.some((e) => e.field === 'url')).toBe(true);
  });

  test('passes uri format', () => {
    const schema = { type: 'object', properties: { url: { type: 'string', format: 'uri' } } };
    expect(validate({ url: 'https://example.com' }, schema)).toEqual([]);
  });

  test('fails pattern', () => {
    const schema = { type: 'object', properties: { code: { type: 'string', pattern: '^[A-Z]+$' } } };
    const errors = validate({ code: 'abc' }, schema);
    expect(errors.some((e) => e.field === 'code')).toBe(true);
  });

  test('passes pattern', () => {
    const schema = { type: 'object', properties: { code: { type: 'string', pattern: '^[A-Z]+$' } } };
    expect(validate({ code: 'ABC' }, schema)).toEqual([]);
  });
});

describe('validate — number constraints', () => {
  test('fails minimum', () => {
    const schema = { type: 'object', properties: { age: { type: 'number', minimum: 18 } } };
    const errors = validate({ age: 17 }, schema);
    expect(errors.some((e) => e.field === 'age')).toBe(true);
  });

  test('passes minimum', () => {
    const schema = { type: 'object', properties: { age: { type: 'number', minimum: 18 } } };
    expect(validate({ age: 18 }, schema)).toEqual([]);
  });

  test('fails exclusiveMinimum', () => {
    const schema = { type: 'object', properties: { x: { type: 'number', exclusiveMinimum: 0 } } };
    const errors = validate({ x: 0 }, schema);
    expect(errors.some((e) => e.field === 'x')).toBe(true);
  });

  test('fails maximum', () => {
    const schema = { type: 'object', properties: { score: { type: 'number', maximum: 100 } } };
    const errors = validate({ score: 101 }, schema);
    expect(errors.some((e) => e.field === 'score')).toBe(true);
  });

  test('fails exclusiveMaximum', () => {
    const schema = { type: 'object', properties: { x: { type: 'number', exclusiveMaximum: 10 } } };
    const errors = validate({ x: 10 }, schema);
    expect(errors.some((e) => e.field === 'x')).toBe(true);
  });

  test('fails const', () => {
    const schema = { type: 'object', properties: { val: { const: 42 } } };
    const errors = validate({ val: 43 }, schema);
    expect(errors.some((e) => e.field === 'val')).toBe(true);
  });

  test('passes const', () => {
    const schema = { type: 'object', properties: { val: { const: 42 } } };
    expect(validate({ val: 42 }, schema)).toEqual([]);
  });
});

describe('validate — enum', () => {
  test('fails enum when value not in list', () => {
    const schema = { type: 'object', properties: { color: { type: 'string', enum: ['Red', 'Blue'] } } };
    const errors = validate({ color: 'Green' }, schema);
    expect(errors.some((e) => e.field === 'color')).toBe(true);
  });

  test('passes enum when value in list', () => {
    const schema = { type: 'object', properties: { color: { type: 'string', enum: ['Red', 'Blue'] } } };
    expect(validate({ color: 'Red' }, schema)).toEqual([]);
  });
});

describe('validate — array constraints', () => {
  test('fails minItems', () => {
    const schema = { type: 'object', properties: { tags: { type: 'array', minItems: 1 } } };
    const errors = validate({ tags: [] }, schema);
    expect(errors.some((e) => e.field === 'tags')).toBe(true);
  });

  test('passes minItems', () => {
    const schema = { type: 'object', properties: { tags: { type: 'array', minItems: 1 } } };
    expect(validate({ tags: ['a'] }, schema)).toEqual([]);
  });

  test('fails uniqueItems', () => {
    const schema = { type: 'object', properties: { tags: { type: 'array', uniqueItems: true } } };
    const errors = validate({ tags: ['a', 'a'] }, schema);
    expect(errors.some((e) => e.field === 'tags')).toBe(true);
  });

  test('passes uniqueItems with distinct values', () => {
    const schema = { type: 'object', properties: { tags: { type: 'array', uniqueItems: true } } };
    expect(validate({ tags: ['a', 'b'] }, schema)).toEqual([]);
  });

  test('validates items type', () => {
    const schema = { type: 'object', properties: { nums: { type: 'array', items: { type: 'integer' } } } };
    const errors = validate({ nums: [1, 'two', 3] }, schema);
    expect(errors.some((e) => e.field.startsWith('nums'))).toBe(true);
  });
});

describe('validate — logical combinators', () => {
  test('allOf: all constraints apply', () => {
    const schema = {
      type: 'object',
      properties: {
        code: { type: 'string', allOf: [{ pattern: '^[A-Z]' }, { minLength: 3 }] },
      },
    };
    expect(validate({ code: 'ABC' }, schema)).toEqual([]);
    const errors = validate({ code: 'ab' }, schema);
    expect(errors.some((e) => e.field === 'code')).toBe(true);
  });

  test('not: negates constraint', () => {
    const schema = {
      type: 'object',
      properties: {
        val: { type: 'number', allOf: [{ not: { const: 0 } }] },
      },
    };
    expect(validate({ val: 1 }, schema)).toEqual([]);
    const errors = validate({ val: 0 }, schema);
    expect(errors.some((e) => e.field === 'val')).toBe(true);
  });

  test('anyOf: at least one must match', () => {
    const schema = {
      type: 'object',
      properties: {
        x: { type: 'number', anyOf: [{ maximum: 0 }, { minimum: 10 }] },
      },
    };
    expect(validate({ x: -1 }, schema)).toEqual([]);
    expect(validate({ x: 15 }, schema)).toEqual([]);
    const errors = validate({ x: 5 }, schema);
    expect(errors.some((e) => e.field === 'x')).toBe(true);
  });
});

describe('validate — optional fields', () => {
  test('skips validation for absent optional fields', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 3 },
      },
    };
    expect(validate({}, schema)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests — confirm failures**

```bash
cd /Users/ruoshi/code/github/gforms-proxy && pnpm test src/lib/__tests__/validator.test.ts 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module '../validator.js'`

- [ ] **Step 3: Implement src/lib/validator.ts**

Create `src/lib/validator.ts`:

```typescript
export interface ValidationError {
  field: string;
  message: string;
}

type Schema = Record<string, unknown>;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return isObject(value);
    case 'null': return value === null;
    default: return true;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URI_RE = /^https?:\/\/.+/;

function validateProperty(
  field: string,
  value: unknown,
  schema: Schema,
  errors: ValidationError[],
): void {
  const type = schema['type'];
  if (typeof type === 'string' && !checkType(value, type)) {
    errors.push({ field, message: `must be of type ${type}` });
    return;
  }

  if ('const' in schema && value !== schema['const']) {
    errors.push({ field, message: `must equal ${JSON.stringify(schema['const'])}` });
    return;
  }

  if (Array.isArray(schema['enum'])) {
    const enumValues = schema['enum'] as unknown[];
    if (!enumValues.includes(value)) {
      errors.push({ field, message: `must be one of: ${enumValues.join(', ')}` });
    }
    return;
  }

  if (typeof value === 'string') {
    const minLength = schema['minLength'];
    if (typeof minLength === 'number' && value.length < minLength) {
      errors.push({ field, message: `must be at least ${minLength} character(s)` });
    }
    const maxLength = schema['maxLength'];
    if (typeof maxLength === 'number' && value.length > maxLength) {
      errors.push({ field, message: `must be at most ${maxLength} character(s)` });
    }
    const format = schema['format'];
    if (format === 'email' && !EMAIL_RE.test(value)) {
      errors.push({ field, message: 'must match format: email' });
    }
    if (format === 'uri' && !URI_RE.test(value)) {
      errors.push({ field, message: 'must match format: uri' });
    }
    const pattern = schema['pattern'];
    if (typeof pattern === 'string' && !new RegExp(pattern).test(value)) {
      errors.push({ field, message: `must match pattern: ${pattern}` });
    }
  }

  if (typeof value === 'number') {
    const minimum = schema['minimum'];
    if (typeof minimum === 'number' && value < minimum) {
      errors.push({ field, message: `must be >= ${minimum}` });
    }
    const exclusiveMinimum = schema['exclusiveMinimum'];
    if (typeof exclusiveMinimum === 'number' && value <= exclusiveMinimum) {
      errors.push({ field, message: `must be > ${exclusiveMinimum}` });
    }
    const maximum = schema['maximum'];
    if (typeof maximum === 'number' && value > maximum) {
      errors.push({ field, message: `must be <= ${maximum}` });
    }
    const exclusiveMaximum = schema['exclusiveMaximum'];
    if (typeof exclusiveMaximum === 'number' && value >= exclusiveMaximum) {
      errors.push({ field, message: `must be < ${exclusiveMaximum}` });
    }
  }

  if (Array.isArray(value)) {
    const minItems = schema['minItems'];
    if (typeof minItems === 'number' && value.length < minItems) {
      errors.push({ field, message: `must have at least ${minItems} item(s)` });
    }
    if (schema['uniqueItems'] === true) {
      const seen = new Set<string>();
      let hasDupe = false;
      for (const item of value) {
        const key = JSON.stringify(item);
        if (seen.has(key)) { hasDupe = true; break; }
        seen.add(key);
      }
      if (hasDupe) errors.push({ field, message: 'items must be unique' });
    }
    const items = schema['items'];
    if (isObject(items)) {
      value.forEach((item, i) => {
        validateProperty(`${field}[${i}]`, item, items, errors);
      });
    }
  }

  const allOf = schema['allOf'];
  if (Array.isArray(allOf)) {
    for (const sub of allOf as Schema[]) {
      if (isObject(sub) && 'not' in sub) {
        const notSchema = sub['not'] as Schema;
        const notErrors: ValidationError[] = [];
        validateProperty(field, value, notSchema, notErrors);
        if (notErrors.length === 0) {
          errors.push({ field, message: `must not match constraint: ${JSON.stringify(notSchema)}` });
        }
      } else if (isObject(sub)) {
        validateProperty(field, value, sub, errors);
      }
    }
  }

  const anyOf = schema['anyOf'];
  if (Array.isArray(anyOf)) {
    const matched = (anyOf as Schema[]).some((sub) => {
      const subErrors: ValidationError[] = [];
      validateProperty(field, value, sub, subErrors);
      return subErrors.length === 0;
    });
    if (!matched) {
      errors.push({ field, message: 'must match at least one of the allowed schemas' });
    }
  }
}

export function validate(
  data: unknown,
  schema: Record<string, unknown>,
): ValidationError[] {
  if (!isObject(data)) {
    return [{ field: '(root)', message: 'must be a JSON object' }];
  }

  const errors: ValidationError[] = [];
  const properties = schema['properties'];
  const required = schema['required'];
  const additionalProperties = schema['additionalProperties'];

  if (Array.isArray(required)) {
    for (const key of required as string[]) {
      if (!(key in data)) {
        errors.push({ field: key, message: 'is required' });
      }
    }
  }

  if (additionalProperties === false && isObject(properties)) {
    for (const key of Object.keys(data)) {
      if (!(key in (properties as object))) {
        errors.push({ field: key, message: 'additional property not allowed' });
      }
    }
  }

  if (isObject(properties)) {
    for (const [key, propSchema] of Object.entries(properties)) {
      if (!(key in data)) continue;
      if (isObject(propSchema)) {
        validateProperty(key, data[key], propSchema, errors);
      }
    }
  }

  return errors;
}
```

- [ ] **Step 4: Run tests — confirm all pass**

```bash
cd /Users/ruoshi/code/github/gforms-proxy && pnpm test src/lib/__tests__/validator.test.ts 2>&1 | tail -20
```

Expected: all validator tests pass.

- [ ] **Step 5: Run full test suite**

```bash
cd /Users/ruoshi/code/github/gforms-proxy && pnpm test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/validator.ts src/lib/__tests__/validator.test.ts
git commit -m "feat: add purpose-built JSON Schema validator"
```

---

## Task 4: Create submitter.ts (TDD)

**Files:**
- Create: `src/lib/__tests__/submitter.test.ts`
- Create: `src/lib/submitter.ts`

- [ ] **Step 1: Write failing tests**

Create `src/lib/__tests__/submitter.test.ts`:

```typescript
import { describe, test, expect, vi, afterEach } from 'vitest';
import { submitToGoogleForms, SubmissionError } from '../submitter.js';

afterEach(() => { vi.restoreAllMocks(); });

const SUBMISSION_URL = 'https://docs.google.com/forms/d/e/test/formResponse';
const FIELD_MAP = {
  full_name: 'entry.111',
  email: 'entry.222',
  tags: 'entry.333',
};

describe('submitToGoogleForms — URL encoding', () => {
  test('encodes string fields as entry.XXXXXXX=value', async () => {
    let capturedBody: string | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = (init?.body as string) ?? null;
      return new Response('', { status: 200 });
    });

    await submitToGoogleForms(SUBMISSION_URL, FIELD_MAP, { full_name: 'Alice', email: 'alice@example.com' });

    expect(capturedBody).toContain('entry.111=Alice');
    expect(capturedBody).toContain('entry.222=alice%40example.com');
  });

  test('encodes array (checkbox) fields by repeating entry ID', async () => {
    let capturedBody: string | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = (init?.body as string) ?? null;
      return new Response('', { status: 200 });
    });

    await submitToGoogleForms(SUBMISSION_URL, FIELD_MAP, { tags: ['a', 'b'] });

    expect(capturedBody).toContain('entry.333=a');
    expect(capturedBody).toContain('entry.333=b');
  });

  test('omits absent optional fields', async () => {
    let capturedBody: string | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = (init?.body as string) ?? null;
      return new Response('', { status: 200 });
    });

    await submitToGoogleForms(SUBMISSION_URL, FIELD_MAP, { full_name: 'Bob' });

    expect(capturedBody).not.toContain('entry.222');
    expect(capturedBody).not.toContain('entry.333');
  });

  test('encodes number fields as string', async () => {
    let capturedBody: string | null = null;
    const fieldMap = { age: 'entry.444' };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = (init?.body as string) ?? null;
      return new Response('', { status: 200 });
    });

    await submitToGoogleForms(SUBMISSION_URL, fieldMap, { age: 25 });

    expect(capturedBody).toContain('entry.444=25');
  });
});

describe('submitToGoogleForms — HTTP behavior', () => {
  test('POSTs to submissionUrl with correct Content-Type', async () => {
    let capturedUrl: string | null = null;
    let capturedHeaders: HeadersInit | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = url as string;
      capturedHeaders = init?.headers;
      return new Response('', { status: 200 });
    });

    await submitToGoogleForms(SUBMISSION_URL, FIELD_MAP, { full_name: 'Alice' });

    expect(capturedUrl).toBe(SUBMISSION_URL);
    const headers = new Headers(capturedHeaders as HeadersInit);
    expect(headers.get('content-type')).toContain('application/x-www-form-urlencoded');
  });

  test('throws SubmissionError on non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));

    await expect(
      submitToGoogleForms(SUBMISSION_URL, FIELD_MAP, { full_name: 'Alice' }),
    ).rejects.toThrow(SubmissionError);
  });

  test('throws SubmissionError on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    await expect(
      submitToGoogleForms(SUBMISSION_URL, FIELD_MAP, { full_name: 'Alice' }),
    ).rejects.toThrow(SubmissionError);
  });
});
```

- [ ] **Step 2: Run tests — confirm failures**

```bash
cd /Users/ruoshi/code/github/gforms-proxy && pnpm test src/lib/__tests__/submitter.test.ts 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module '../submitter.js'`

- [ ] **Step 3: Implement src/lib/submitter.ts**

Create `src/lib/submitter.ts`:

```typescript
export class SubmissionError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'SubmissionError';
  }
}

export async function submitToGoogleForms(
  submissionUrl: string,
  fieldMap: Record<string, string>,
  data: Record<string, unknown>,
): Promise<void> {
  const parts: string[] = [];

  for (const [key, entryId] of Object.entries(fieldMap)) {
    const value = data[key];
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        parts.push(`${encodeURIComponent(entryId)}=${encodeURIComponent(String(item))}`);
      }
    } else {
      parts.push(`${encodeURIComponent(entryId)}=${encodeURIComponent(String(value))}`);
    }
  }

  const body = parts.join('&');

  let response: Response;
  try {
    response = await fetch(submissionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch {
    throw new SubmissionError('Network error: could not reach Google Forms');
  }

  if (!response.ok) {
    throw new SubmissionError(
      `Google Forms returned HTTP ${response.status}`,
      response.status,
    );
  }
}
```

- [ ] **Step 4: Run tests — confirm all pass**

```bash
cd /Users/ruoshi/code/github/gforms-proxy && pnpm test src/lib/__tests__/submitter.test.ts 2>&1 | tail -20
```

Expected: all submitter tests pass.

- [ ] **Step 5: Run full test suite**

```bash
cd /Users/ruoshi/code/github/gforms-proxy && pnpm test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/submitter.ts src/lib/__tests__/submitter.test.ts
git commit -m "feat: add Google Forms form-urlencoded submitter"
```

---

## Task 5: Create forms registry

**Files:**
- Create: `src/forms/registry.ts`

- [ ] **Step 1: Create registry file**

```bash
mkdir -p /Users/ruoshi/code/github/gforms-proxy/src/forms
```

Create `src/forms/registry.ts`:

```typescript
import type { FormDefinition } from '../lib/types.js';

// Add imports here as new forms are registered:
// import form1 from './1FAIpQLSabc123.json' with { type: 'json' };

const registry = new Map<string, FormDefinition>([
  // Add entries here:
  // ['1FAIpQLSabc123', form1 as FormDefinition],
]);

export default registry;
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/ruoshi/code/github/gforms-proxy && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/forms/registry.ts
git commit -m "feat: add static form definition registry"
```

---

## Task 6: Add POST /api/v1/forms/:formId/responses to index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing integration test**

Create `src/lib/__tests__/index.test.ts`:

```typescript
import { describe, test, expect, vi, afterEach } from 'vitest';
import type { FormDefinition } from '../types.js';

// We test the route handler by importing app and calling it with a mock registry.
// We patch the registry module before importing app.

const MOCK_DEFINITION: FormDefinition = {
  formId: 'testForm123',
  submissionUrl: 'https://docs.google.com/forms/d/e/testForm123/formResponse',
  schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1 },
    },
  },
  fieldMap: { name: 'entry.999' },
};

vi.mock('../../forms/registry.js', () => ({
  default: new Map([['testForm123', MOCK_DEFINITION]]),
}));

// Import app AFTER mocking the registry
const { default: app } = await import('../../index.js');

afterEach(() => { vi.restoreAllMocks(); });

describe('POST /api/v1/forms/:formId/responses', () => {
  test('returns 404 for unknown formId', async () => {
    const res = await app.request('/api/v1/forms/unknown/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice' }),
    });
    expect(res.status).toBe(404);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('Form not found');
  });

  test('returns 400 for invalid JSON body', async () => {
    const res = await app.request('/api/v1/forms/testForm123/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('Invalid JSON body');
  });

  test('returns 400 with details for schema validation failure', async () => {
    const res = await app.request('/api/v1/forms/testForm123/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extra: 'bad' }),
    });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string; details: unknown[] };
    expect(json.error).toBe('Validation failed');
    expect(Array.isArray(json.details)).toBe(true);
    expect(json.details.length).toBeGreaterThan(0);
  });

  test('returns 200 success on valid submission', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));
    const res = await app.request('/api/v1/forms/testForm123/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice' }),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean };
    expect(json.success).toBe(true);
  });

  test('returns 502 when Google Forms submission fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    const res = await app.request('/api/v1/forms/testForm123/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice' }),
    });
    expect(res.status).toBe(502);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('Failed to submit to Google Forms');
  });
});
```

- [ ] **Step 2: Run test — confirm failures**

```bash
cd /Users/ruoshi/code/github/gforms-proxy && pnpm test src/lib/__tests__/index.test.ts 2>&1 | tail -20
```

Expected: FAIL — route not found (404 for all routes).

- [ ] **Step 3: Add route to src/index.ts**

Add these imports at the top of `src/index.ts`:

```typescript
import registry from './forms/registry.js';
import { validate } from './lib/validator.js';
import { submitToGoogleForms, SubmissionError } from './lib/submitter.js';
```

Add the route handler before `export default app;`:

```typescript
app.post('/api/v1/forms/:formId/responses', async (c) => {
  const formId = c.req.param('formId');
  const definition = registry.get(formId);
  if (!definition) return c.json({ error: 'Form not found' }, 404);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const errors = validate(body, definition.schema);
  if (errors.length > 0) {
    return c.json({ error: 'Validation failed', details: errors }, 400);
  }

  try {
    await submitToGoogleForms(definition.submissionUrl, definition.fieldMap, body);
  } catch (err) {
    if (err instanceof SubmissionError) {
      return c.json({ error: 'Failed to submit to Google Forms' }, 502);
    }
    console.error('Unexpected submission error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }

  return c.json({ success: true });
});
```

- [ ] **Step 4: Run tests — confirm all pass**

```bash
cd /Users/ruoshi/code/github/gforms-proxy && pnpm test 2>&1 | tail -20
```

Expected: all tests pass including the new index.test.ts tests.

- [ ] **Step 5: Type-check**

```bash
cd /Users/ruoshi/code/github/gforms-proxy && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/lib/__tests__/index.test.ts
git commit -m "feat: add POST /api/v1/forms/:formId/responses route"
```

---

## Task 7: Rewrite scripts/gen-field-mapping.ts

**Files:**
- Rewrite: `scripts/gen-field-mapping.ts`

The existing file imports `axios`, `chalk`, `ora`, `@inquirer/prompts` — all removed. Replace entirely.

- [ ] **Step 1: Rewrite the CLI script**

Replace all content of `scripts/gen-field-mapping.ts` with:

```typescript
#!/usr/bin/env tsx
/**
 * CLI: Given a public Google Form URL, prints its JSON Schema to stdout.
 * With --out <path>, also writes a FormDefinition JSON file.
 *
 * Usage:
 *   tsx scripts/gen-field-mapping.ts --url <viewform_url> [--out <path>] [--gemini-key <key>]
 */
import { writeFileSync } from 'node:fs';
import { fetchAndParseForm } from '../src/lib/parser.js';
import { buildJsonSchema, buildFieldsMeta, buildFieldMap } from '../src/lib/schema.js';
import type { FormDefinition } from '../src/lib/types.js';

function parseArgs(argv: string[]): { url: string; out: string | null; geminiKey: string | null } {
  const args = argv.slice(2);
  let url = '';
  let out: string | null = null;
  let geminiKey: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--url' && args[i + 1]) {
      url = args[++i] ?? '';
    } else if (arg === '--out' && args[i + 1]) {
      out = args[++i] ?? null;
    } else if (arg === '--gemini-key' && args[i + 1]) {
      geminiKey = args[++i] ?? null;
    }
  }

  if (!url) {
    console.error('Usage: tsx scripts/gen-field-mapping.ts --url <viewform_url> [--out <path>] [--gemini-key <key>]');
    process.exit(1);
  }

  return { url, out, geminiKey };
}

async function main(): Promise<void> {
  const { url, out, geminiKey } = parseArgs(process.argv);
  const apiKey = geminiKey ?? process.env['GEMINI_API_KEY'] ?? null;

  console.error(`Fetching form: ${url}`);
  const rawData = await fetchAndParseForm(url);
  console.error(`Found ${rawData.fields.length} fields in: ${rawData.formTitle}`);

  if (out) {
    // Build metas once and share between schema + fieldMap to avoid double Gemini call
    const metas = await buildFieldsMeta(rawData.fields.map((f) => f.label), apiKey);
    const schema = await buildJsonSchema(rawData, apiKey, metas);
    const fieldMap = buildFieldMap(rawData.fields, metas);
    const submissionUrl = `https://docs.google.com/forms/d/e/${rawData.formId}/formResponse`;

    const definition: FormDefinition = {
      formId: rawData.formId,
      submissionUrl,
      schema,
      fieldMap,
    };

    writeFileSync(out, JSON.stringify(definition, null, 2) + '\n');
    console.error(`\nFormDefinition written to: ${out}`);
    console.error('\nNext steps:');
    console.error(`  1. Add to src/forms/registry.ts:`);
    console.error(`     import form from './${rawData.formId}.json' with { type: 'json' };`);
    console.error(`     // In the Map: ['${rawData.formId}', form as FormDefinition]`);
    console.error('  2. pnpm deploy');
  } else {
    const schema = await buildJsonSchema(rawData, apiKey);
    console.log(JSON.stringify(schema, null, 2));
  }
}

main().catch((err: unknown) => {
  console.error('Error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

- [ ] **Step 2: Verify the script parses without error**

```bash
cd /Users/ruoshi/code/github/gforms-proxy && npx tsx --version 2>/dev/null || echo "tsx via pnpm exec"
pnpm exec tsx scripts/gen-field-mapping.ts 2>&1 | head -5
```

Expected: prints usage error (`Usage: tsx scripts/gen-field-mapping.ts ...`) and exits — this confirms it loads without import errors.

- [ ] **Step 3: Run full test suite one more time**

```bash
cd /Users/ruoshi/code/github/gforms-proxy && pnpm test 2>&1 | tail -15
```

Expected: all tests still pass (scripts/ is excluded from tsconfig, no interference).

- [ ] **Step 4: Commit**

```bash
git add scripts/gen-field-mapping.ts
git commit -m "feat: rewrite CLI to use src/lib modules with --url/--out/--gemini-key flags"
```

---

## Post-Implementation Checklist

- [ ] All tests pass: `pnpm test`
- [ ] No TypeScript errors: `npx tsc --noEmit`
- [ ] `pnpm dev` starts the Worker without errors
- [ ] `GET /` returns expected JSON (health check)
- [ ] `POST /api/v1/forms/unknown/responses` returns 404
- [ ] CLI usage error shown: `pnpm exec tsx scripts/gen-field-mapping.ts`
