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

const DUPLICATE_QUESTION = 'Is customer status clearly recorded somewhere right now?';

// 18 short-answer fields mirroring the AI-readiness form's shape: the same
// question appears twice (indices 4 and 11).
const LABELS = Array.from({ length: 18 }, (_, i) =>
  i === 4 || i === 11 ? DUPLICATE_QUESTION : `Question ${i + 1}?`,
);

const payloadFor = (labels: string[]) =>
  JSON.stringify([
    null,
    [null, labels.map((label, i) => [null, label, '', 0, [[100001 + i, null, 0]]])],
  ]);

const htmlFor = (labels: string[]) =>
  `<html><head><title>AI Readiness Self-Check - Google Forms</title></head>
<body><script>var FB_PUBLIC_LOAD_DATA_ = ${payloadFor(labels)};\n</script></body></html>`;

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
  test('18-field form with a duplicate question retains all 18 fields', async () => {
    const formId = 'aiReadinessFixture';
    // Gemini derives keys from meaning, so the duplicate question yields the
    // same key twice.
    geminiMetas = LABELS.map((label, i) =>
      label === DUPLICATE_QUESTION ? meta('customer_status_recorded') : meta(`q_${i + 1}`),
    );
    vi.stubGlobal('fetch', vi.fn(async () => new Response(htmlFor(LABELS))));

    await main(['node', 'gen-field-mapping.ts', '--url', `https://docs.google.com/forms/d/e/${formId}/viewform`]);
    vi.unstubAllGlobals();

    const definition = readDefinition(formId);
    const propertyKeys = Object.keys(definition.schema.properties);
    const fieldMapKeys = Object.keys(definition.fieldMap);
    expect(fieldMapKeys).toHaveLength(18);
    expect(propertyKeys).toEqual(fieldMapKeys);
    expect(fieldMapKeys).toContain('customer_status_recorded');
    expect(fieldMapKeys).toContain('customer_status_recorded_2');
    expect(definition.fieldMap['customer_status_recorded']).toBe('entry.100005');
    expect(definition.fieldMap['customer_status_recorded_2']).toBe('entry.100012');
  });

  test('--turnstile splice never collides with a Gemini turnstile_token key', async () => {
    const formId = 'turnstileCollisionFixture';
    const labels = ['Paste your token', 'Anything else?'];
    geminiMetas = [meta('turnstile_token'), meta('comments')];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(htmlFor(labels))));

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
