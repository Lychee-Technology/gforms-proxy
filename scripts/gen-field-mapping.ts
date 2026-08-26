#!/usr/bin/env tsx
/**
 * CLI: Given a public Google Form URL, fetches the form and writes a
 * FormDefinition JSON file to src/forms/<formId>.json.
 *
 * Usage:
 *   tsx scripts/gen-field-mapping.ts --url <viewform_url> [--gemini-key <key>] [--turnstile] [--force]
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractFormId, fetchAndParseForm, validateFormUrl } from '../src/lib/parser.js';
import { buildJsonSchema, buildFieldMap } from '../src/lib/schema.js';
import { buildFieldsMetaWithGemini } from './gemini.js';
import { checkTurnstileDowngrade } from './turnstile-guard.js';
import type { FormDefinition } from '../src/lib/types.js';

function printUsage(): void {
  console.error('Usage: tsx scripts/gen-field-mapping.ts --url <viewform_url> [--gemini-key <key>] [--turnstile] [--force]');
}

function parseArgs(argv: string[]): { url: string; geminiKey: string | null; turnstile: boolean; force: boolean } {
  const args = argv.slice(2);
  let url = '';
  let geminiKey: string | null = null;
  let turnstile = false;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--url' && args[i + 1]) {
      url = args[++i] ?? '';
    } else if (arg === '--gemini-key' && args[i + 1]) {
      geminiKey = args[++i] ?? null;
    } else if (arg === '--turnstile') {
      turnstile = true;
    } else if (arg === '--force') {
      force = true;
    } else {
      console.error(`Unknown argument: ${arg}`);
      printUsage();
      process.exit(1);
    }
  }

  if (!url) {
    printUsage();
    process.exit(1);
  }

  return { url, geminiKey, turnstile, force };
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const { url, geminiKey, turnstile, force } = parseArgs(argv);
  const apiKey = geminiKey ?? process.env['GEMINI_API_KEY'] ?? null;

  // Reject invalid URLs before the guard so they report as URL errors, not
  // as a turnstile downgrade. Then guard before fetching: formId is derived
  // from the URL alone, so a doomed regeneration can abort without a network
  // round-trip.
  validateFormUrl(url);
  const formId = extractFormId(url);
  const out = resolve(process.cwd(), 'src/forms', `${formId}.json`);
  const downgradeError = checkTurnstileDowngrade(out, { turnstile, force });
  if (downgradeError) {
    console.error(`Error: ${downgradeError}`);
    process.exit(1);
  }

  console.error(`Fetching form: ${url}`);
  const rawData = await fetchAndParseForm(url);
  console.error(`Found ${rawData.fields.length} fields in: ${rawData.formTitle}`);

  const metas = await buildFieldsMetaWithGemini(rawData.fields.map((f) => f.label), apiKey);
  const baseSchema = buildJsonSchema(rawData, metas);
  const schema: Record<string, unknown> = turnstile
    ? {
        ...baseSchema,
        properties: {
          ...(baseSchema.properties as Record<string, unknown>),
          turnstile_token: { type: 'string', description: 'Cloudflare Turnstile token' },
        },
        required: [...((baseSchema.required as string[]) ?? []), 'turnstile_token'],
      }
    : baseSchema;
  const fieldMap = buildFieldMap(rawData.fields, metas);
  const submissionUrl = `https://docs.google.com/forms/d/e/${rawData.formId}/formResponse`;

  const definition: FormDefinition = {
    formId: rawData.formId,
    submissionUrl,
    schema,
    fieldMap,
    ...(turnstile && { turnstileEnabled: true }),
  };

  writeFileSync(out, JSON.stringify(definition, null, 2) + '\n');
  console.error(`\nFormDefinition written to: ${out}`);
  console.error('\nNext steps:');
  console.error(`  1. Add to src/forms/registry.ts:`);
  console.error(`     import form from './${rawData.formId}.json' with { type: 'json' };`);
  console.error(`     // In the Map: ['${rawData.formId}', form as FormDefinition]`);
  console.error('  2. pnpm deploy');
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((err: unknown) => {
    console.error('Error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
