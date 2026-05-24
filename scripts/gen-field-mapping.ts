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
