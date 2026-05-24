# gen-field-mapping Auto Output Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `--out` from `gen-field-mapping.ts` so the script always writes `FormDefinition` to `src/forms/<formId>.json` automatically.

**Architecture:** Single file edit. Remove the `out` argument, compute the output path from `rawData.formId` after fetching, and make the file-write unconditional. The stdout schema-print branch is deleted.

**Tech Stack:** Node.js (`node:path`), TypeScript, tsx

---

### Task 1: Update gen-field-mapping.ts

**Files:**
- Modify: `scripts/gen-field-mapping.ts`

- [ ] **Step 1: Add `node:path` import and remove `--out` from parseArgs**

Replace the top of `scripts/gen-field-mapping.ts` with:

```typescript
#!/usr/bin/env tsx
/**
 * CLI: Given a public Google Form URL, fetches the form and writes a
 * FormDefinition JSON file to src/forms/<formId>.json.
 *
 * Usage:
 *   tsx scripts/gen-field-mapping.ts --url <viewform_url> [--gemini-key <key>]
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchAndParseForm } from '../src/lib/parser.js';
import { buildJsonSchema, buildFieldMap } from '../src/lib/schema.js';
import { buildFieldsMetaWithGemini } from './gemini.js';
import type { FormDefinition } from '../src/lib/types.js';

function parseArgs(argv: string[]): { url: string; geminiKey: string | null } {
  const args = argv.slice(2);
  let url = '';
  let geminiKey: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--url' && args[i + 1]) {
      url = args[++i] ?? '';
    } else if (arg === '--gemini-key' && args[i + 1]) {
      geminiKey = args[++i] ?? null;
    }
  }

  if (!url) {
    console.error('Usage: tsx scripts/gen-field-mapping.ts --url <viewform_url> [--gemini-key <key>]');
    process.exit(1);
  }

  return { url, geminiKey };
}
```

- [ ] **Step 2: Replace the main function body**

Replace the `main` function with:

```typescript
async function main(): Promise<void> {
  const { url, geminiKey } = parseArgs(process.argv);
  const apiKey = geminiKey ?? process.env['GEMINI_API_KEY'] ?? null;

  console.error(`Fetching form: ${url}`);
  const rawData = await fetchAndParseForm(url);
  console.error(`Found ${rawData.fields.length} fields in: ${rawData.formTitle}`);

  const metas = await buildFieldsMetaWithGemini(rawData.fields.map((f) => f.label), apiKey);
  const schema = buildJsonSchema(rawData, metas);
  const fieldMap = buildFieldMap(rawData.fields, metas);
  const submissionUrl = `https://docs.google.com/forms/d/e/${rawData.formId}/formResponse`;

  const definition: FormDefinition = {
    formId: rawData.formId,
    submissionUrl,
    schema,
    fieldMap,
  };

  const out = resolve(process.cwd(), 'src/forms', `${rawData.formId}.json`);
  writeFileSync(out, JSON.stringify(definition, null, 2) + '\n');
  console.error(`\nFormDefinition written to: ${out}`);
  console.error('\nNext steps:');
  console.error(`  1. Add to src/forms/registry.ts:`);
  console.error(`     import form from './${rawData.formId}.json' with { type: 'json' };`);
  console.error(`     // In the Map: ['${rawData.formId}', form as FormDefinition]`);
  console.error('  2. pnpm deploy');
}

main().catch((err: unknown) => {
  console.error('Error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

- [ ] **Step 3: Verify TypeScript compiles cleanly**

```bash
pnpm exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Run existing tests to confirm no regressions**

```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/gen-field-mapping.ts
git commit -m "feat: auto-generate output path from form ID in gen-field-mapping"
```
