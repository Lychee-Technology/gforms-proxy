import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FieldMeta } from '../../src/lib/types.js';
import { main } from '../gen-field-mapping.js';

// Simulates the Gemini path: main() only imports buildFieldsMetaWithGemini,
// so each test sets geminiMetas to the keys "Gemini" would return.
let geminiMetas: FieldMeta[] = [];
vi.mock('../gemini.js', () => ({
  buildFieldsMetaWithGemini: vi.fn(async () => geminiMetas),
}));

// The committed AI-readiness definition: its question labels (including the
// genuinely duplicated one) and entry IDs are the regeneration fixture, so the
// test follows the real form definition instead of a synthetic stand-in.
const AI_READINESS = JSON.parse(
  readFileSync(
    new URL(
      '../../src/forms/1FAIpQLSdT6je0hJmpQLbEKUa4Bm4-skYEg64DNmGhJtLpDE2wjAxGKQ.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { formId: string; schema: { properties: Record<string, { title: string }> }; fieldMap: Record<string, string> };

const payloadFor = (labels: string[], entryIds: number[]) =>
  JSON.stringify([
    null,
    [null, labels.map((label, i) => [null, label, '', 0, [[entryIds[i], null, 0]]])],
  ]);

const htmlFor = (labels: string[], entryIds: number[]) =>
  `<html><head><title>AI Readiness Self-Check - Google Forms</title></head>
<body><script>var FB_PUBLIC_LOAD_DATA_ = ${payloadFor(labels, entryIds)};\n</script></body></html>`;

const meta = (key: string): FieldMeta => ({ title: key, key, translated: key });

let workDir: string;
let originalCwd: string;

function readDefinition(formId: string): Record<string, any> {
  return JSON.parse(readFileSync(join(workDir, 'src', 'forms', `${formId}.json`), 'utf8'));
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'gen-field-mapping-dedupe-'));
  mkdirSync(join(workDir, 'src', 'forms'), { recursive: true });
  originalCwd = process.cwd();
  process.chdir(workDir);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('main() with colliding Gemini keys', () => {
  test('regenerating the AI-readiness form retains all 18 fields', async () => {
    const labels = Object.values(AI_READINESS.schema.properties).map((p) => p.title);
    const committedEntryIds = Object.values(AI_READINESS.fieldMap);
    const entryIds = committedEntryIds.map((id) => Number(id.replace('entry.', '')));
    // The issue's acceptance criterion is stated against this 18-field form.
    expect(labels).toHaveLength(18);
    const duplicated = labels.filter((l, i) => labels.indexOf(l) !== i);
    expect(duplicated.length).toBeGreaterThan(0);

    // Gemini derives keys from meaning, so the duplicated question yields the
    // same key for both occurrences.
    const slug = (label: string) =>
      label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
    geminiMetas = labels.map((l) => meta(slug(l)));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(htmlFor(labels, entryIds))));

    await main(['node', 'gen-field-mapping.ts', '--url', `https://docs.google.com/forms/d/e/${AI_READINESS.formId}/viewform`]);
    vi.unstubAllGlobals();

    const definition = readDefinition(AI_READINESS.formId);
    const propertyKeys = Object.keys(definition.schema.properties);
    const fieldMapKeys = Object.keys(definition.fieldMap);
    expect(fieldMapKeys).toHaveLength(18);
    expect(propertyKeys).toEqual(fieldMapKeys);
    // Every committed entry ID still receives data, in order.
    expect(Object.values(definition.fieldMap)).toEqual(committedEntryIds);
    // The duplicated question kept both occurrences under distinct keys.
    const dupKey = slug(duplicated[0] as string);
    expect(fieldMapKeys).toContain(dupKey);
    expect(fieldMapKeys).toContain(`${dupKey}_2`);
  });

  test('--turnstile splice never collides with a Gemini turnstile_token key', async () => {
    const formId = 'turnstileCollisionFixture';
    const labels = ['Paste your token', 'Anything else?'];
    geminiMetas = [meta('turnstile_token'), meta('comments')];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(htmlFor(labels, [100001, 100002]))));

    await main([
      'node',
      'gen-field-mapping.ts',
      '--url',
      `https://docs.google.com/forms/d/e/${formId}/viewform`,
      '--turnstile',
    ]);
    vi.unstubAllGlobals();

    const definition = readDefinition(formId);
    // The form field was renamed; the reserved key holds only the splice.
    expect(definition.fieldMap).toEqual({
      turnstile_token_2: 'entry.100001',
      comments: 'entry.100002',
    });
    expect(definition.schema.properties.turnstile_token).toEqual({
      type: 'string',
      description: 'Cloudflare Turnstile token',
    });
    expect(definition.schema.properties.turnstile_token_2.title).toBe('Paste your token');
    expect(definition.schema.required).toContain('turnstile_token');
    expect(definition.turnstileEnabled).toBe(true);
  });
});
