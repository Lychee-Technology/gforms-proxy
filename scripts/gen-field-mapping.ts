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
